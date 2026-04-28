#!/usr/bin/env python3
import argparse
import configparser
import io
import json
import mimetypes
import os
import posixpath
import re
import shutil
import sys
import tempfile
import threading
import time
import traceback
import uuid
import webbrowser
from concurrent.futures import ThreadPoolExecutor, as_completed
from email.parser import BytesParser
from email.policy import default as email_policy
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

try:
    import boto3
    from botocore.exceptions import BotoCoreError, ClientError
    from boto3.s3.transfer import TransferConfig
except ImportError:
    boto3 = None
    BotoCoreError = ClientError = Exception
    TransferConfig = None


def app_root():
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def resource_root():
    bundled_root = getattr(sys, "_MEIPASS", "")
    if bundled_root:
        return Path(bundled_root)
    return Path(__file__).resolve().parent


def user_data_dir():
    if not getattr(sys, "frozen", False):
        return app_root() / "data"
    if os.name == "nt":
        base = Path(os.environ.get("APPDATA") or app_root())
        return base / "s3explorer"
    base = Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share"))
    return base / "s3explorer"


APP_ROOT = app_root()
RESOURCE_ROOT = resource_root()
DATA_DIR = user_data_dir()
ACCOUNTS_FILE = DATA_DIR / "accounts.json"
HISTORY_DIR = DATA_DIR / "history"
STATIC_DIR = RESOURCE_ROOT / "static"
DOWNLOAD_JOBS = {}
DOWNLOAD_JOBS_LOCK = threading.Lock()
S3_TRANSFER_CONFIG = (
    TransferConfig(
        multipart_threshold=64 * 1024 * 1024,
        multipart_chunksize=64 * 1024 * 1024,
        max_concurrency=8,
        use_threads=True,
    )
    if TransferConfig
    else None
)
TEXT_EXTENSIONS = {
    ".txt",
    ".xml",
    ".json",
    ".config",
    ".properties",
    ".conf",
    ".cfg",
    ".ini",
    ".yaml",
    ".yml",
    ".md",
    ".csv",
    ".log",
    ".sh",
    ".env",
    ".tpl",
    ".script",
    ".py",
    ".c",
    ".go",
    ".cpp",
    ".cc",
    ".cxx",
    ".h",
    ".hpp",
    ".java",
}
IMAGE_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".bmp",
    ".gif",
}


def preview_kind_for_name(name):
    suffix = Path(name).suffix.lower()
    if suffix in TEXT_EXTENSIONS:
        return "text"
    if suffix in IMAGE_EXTENSIONS:
        return "image"
    return ""


def ensure_data():
    DATA_DIR.mkdir(exist_ok=True)
    HISTORY_DIR.mkdir(exist_ok=True)
    if accounts_file_needs_import():
        save_accounts(load_aws_profiles())


def accounts_file_needs_import():
    if not ACCOUNTS_FILE.exists():
        return True
    try:
        with ACCOUNTS_FILE.open("r", encoding="utf-8") as fh:
            accounts = json.load(fh)
        return not isinstance(accounts, list) or len(accounts) == 0
    except (OSError, json.JSONDecodeError):
        return True


def load_aws_profiles():
    credentials = configparser.RawConfigParser()
    config = configparser.RawConfigParser()
    credentials.read(Path.home() / ".aws" / "credentials")
    config.read(Path.home() / ".aws" / "config")

    names = set(credentials.sections())
    for section in config.sections():
        names.add(section.removeprefix("profile "))

    accounts = []
    for name in sorted(names, key=lambda item: (item != "default", item)):
        cred_section = name
        config_section = "default" if name == "default" else f"profile {name}"
        accounts.append(
            {
                "id": slugify(name),
                "name": name,
                "keyId": credentials.get(cred_section, "aws_access_key_id", fallback=""),
                "accessKey": credentials.get(cred_section, "aws_secret_access_key", fallback=""),
                "area": config.get(config_section, "region", fallback="us-east-1"),
                "format": config.get(config_section, "output", fallback="json") or "json",
            }
        )
    return accounts


def slugify(value):
    slug = re.sub(r"[^a-zA-Z0-9_.-]+", "-", value.strip()).strip("-")
    return slug or f"account-{int(time.time())}"


def load_accounts():
    if not ACCOUNTS_FILE.exists():
        return []
    with ACCOUNTS_FILE.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def save_accounts(accounts):
    DATA_DIR.mkdir(exist_ok=True)
    with ACCOUNTS_FILE.open("w", encoding="utf-8") as fh:
        json.dump(accounts, fh, ensure_ascii=False, indent=2)


def account_by_id(account_id):
    for account in load_accounts():
        if account["id"] == account_id:
            return account
    raise AppError(HTTPStatus.NOT_FOUND, "Account not found")


class AppError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message
        super().__init__(message)


def s3_client(account):
    if boto3 is None:
        raise AppError(HTTPStatus.INTERNAL_SERVER_ERROR, "boto3 is not installed. Run: python3 -m pip install -r requirements.txt")
    return boto3.client(
        "s3",
        aws_access_key_id=account.get("keyId", ""),
        aws_secret_access_key=account.get("accessKey", ""),
        region_name=account.get("area") or "us-east-1",
    )


def s3_call(callback):
    try:
        return callback()
    except ClientError as exc:
        message = exc.response.get("Error", {}).get("Message") or str(exc)
        raise AppError(HTTPStatus.BAD_GATEWAY, message)
    except BotoCoreError as exc:
        raise AppError(HTTPStatus.BAD_GATEWAY, str(exc))


def list_objects_tree(account, bucket, prefix="", token=""):
    client = s3_client(account)
    args = {"Bucket": bucket, "Prefix": prefix, "Delimiter": "/", "MaxKeys": 200}
    if token:
        args["ContinuationToken"] = token
    data = s3_call(lambda: client.list_objects_v2(**args))
    node = {
        "name": Path(prefix.rstrip("/")).name if prefix else bucket,
        "key": prefix,
        "type": "folder",
        "children": [],
        "loaded": True,
        "hasMore": bool(data.get("IsTruncated")),
        "nextToken": data.get("NextContinuationToken", ""),
    }
    for folder in data.get("CommonPrefixes", []):
        folder_key = folder.get("Prefix", "")
        node["children"].append(
            {
                "name": Path(folder_key.rstrip("/")).name,
                "key": folder_key,
                "type": "folder",
                "children": [],
                "loaded": False,
                "hasMore": False,
                "nextToken": "",
            }
        )
    for item in data.get("Contents", []):
        key = item.get("Key", "")
        if not key or key == prefix or key.endswith("/"):
            continue
        name = key[len(prefix):] if prefix and key.startswith(prefix) else key
        if "/" in name:
            continue
        node["children"].append(
            {
                "name": name,
                "key": key,
                "type": "file",
                "size": item.get("Size", 0),
                "lastModified": format_s3_time(item.get("LastModified")),
                "previewKind": preview_kind_for_name(name),
                "viewable": bool(preview_kind_for_name(name)),
            }
        )
    sort_tree(node)
    return node


def list_object_files(account, bucket, prefix=""):
    client = s3_client(account)
    files = []
    paginator = client.get_paginator("list_objects_v2")
    pages = s3_call(lambda: paginator.paginate(Bucket=bucket, Prefix=prefix))
    for data in pages:
        for item in data.get("Contents", []):
            key = item.get("Key", "")
            if key and not key.endswith("/"):
                files.append({"key": key, "size": item.get("Size", 0)})
    return files


def add_object_to_tree(root, folders, item):
    key = item.get("Key", "")
    if not key:
        return
    parts = [part for part in key.split("/") if part]
    current_key = ""
    parent = root
    for index, part in enumerate(parts):
        is_file = index == len(parts) - 1 and not key.endswith("/")
        current_key = f"{current_key}{part}" if not current_key else f"{current_key}/{part}"
        if is_file:
            parent["children"].append(
                {
                    "name": part,
                    "key": key,
                    "type": "file",
                    "size": item.get("Size", 0),
                    "lastModified": format_s3_time(item.get("LastModified")),
                    "previewKind": preview_kind_for_name(part),
                    "viewable": bool(preview_kind_for_name(part)),
                }
            )
        else:
            folder_key = f"{current_key}/"
            if folder_key not in folders:
                node = {"name": part, "key": folder_key, "type": "folder", "children": []}
                folders[folder_key] = node
                parent["children"].append(node)
            parent = folders[folder_key]


def sort_tree(node):
    node["children"].sort(key=lambda child: (child["type"] != "folder", child["name"].lower()))
    for child in node["children"]:
        if child["type"] == "folder":
            sort_tree(child)


def format_s3_time(value):
    if not value:
        return ""
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def delete_prefix(client, bucket, prefix):
    paginator = client.get_paginator("list_objects_v2")
    pages = s3_call(lambda: paginator.paginate(Bucket=bucket, Prefix=prefix))
    batch = []
    for page in pages:
        for item in page.get("Contents", []):
            batch.append({"Key": item["Key"]})
            if len(batch) == 1000:
                s3_call(lambda batch=batch: client.delete_objects(Bucket=bucket, Delete={"Objects": batch}))
                batch = []
    if batch:
        s3_call(lambda: client.delete_objects(Bucket=bucket, Delete={"Objects": batch}))


def ensure_prefix(prefix):
    prefix = clean_key(prefix or "")
    if prefix and not prefix.endswith("/"):
        prefix = f"{prefix}/"
    return prefix


def join_s3_key(prefix, name):
    prefix = ensure_prefix(prefix)
    name = str(name or "").lstrip("/")
    return f"{prefix}{name}" if prefix else name


def ensure_distinct_transfer(source_account_id, source_bucket, source_key, target_account_id, target_bucket, target_key):
    if (
        source_account_id == target_account_id
        and source_bucket == target_bucket
        and clean_key(source_key) == clean_key(target_key)
    ):
        raise AppError(HTTPStatus.BAD_REQUEST, "Source and destination are the same")


def copy_error_message(exc, source_bucket, source_key, target_bucket, target_key, cross_account=False):
    code = exc.response.get("Error", {}).get("Code") or ""
    message = exc.response.get("Error", {}).get("Message") or str(exc)
    if code in {"AccessDenied", "AllAccessDisabled"}:
        if cross_account:
            return (
                "Cross-account server-side copy was denied. "
                "The destination account credentials must be allowed to read "
                f"s3://{source_bucket}/{source_key} and write s3://{target_bucket}/{target_key}. "
                "For move, the source account credentials must also be allowed to delete the source object."
            )
        return (
            "Server-side copy was denied. Check that the active credentials can read "
            f"s3://{source_bucket}/{source_key} and write s3://{target_bucket}/{target_key}."
        )
    return message


def upload_stream_between_clients(source_client, target_client, source_bucket, source_key, target_bucket, target_key, *, callback=None):
    data = s3_call(lambda: source_client.get_object(Bucket=source_bucket, Key=source_key))
    body = data["Body"]
    extra_args = {}
    content_type = data.get("ContentType")
    if content_type:
        extra_args["ContentType"] = content_type
    metadata = data.get("Metadata") or {}
    if metadata:
        extra_args["Metadata"] = metadata
    try:
        upload_kwargs = {"ExtraArgs": extra_args or None}
        if callback is not None:
            upload_kwargs["Callback"] = callback
        if S3_TRANSFER_CONFIG is not None:
            upload_kwargs["Config"] = S3_TRANSFER_CONFIG
        s3_call(lambda: target_client.upload_fileobj(body, target_bucket, target_key, **upload_kwargs))
    finally:
        body.close()


def copy_object_between_clients(source_client, target_client, source_bucket, source_key, target_bucket, target_key, *, callback=None, cross_account=False):
    copy_source = {"Bucket": source_bucket, "Key": source_key}
    copy_kwargs = {"SourceClient": source_client}
    if callback is not None:
        copy_kwargs["Callback"] = callback
    if S3_TRANSFER_CONFIG is not None:
        copy_kwargs["Config"] = S3_TRANSFER_CONFIG
    try:
        return target_client.copy(copy_source, target_bucket, target_key, **copy_kwargs)
    except ClientError as exc:
        raise AppError(
            HTTPStatus.BAD_GATEWAY,
            copy_error_message(exc, source_bucket, source_key, target_bucket, target_key, cross_account=cross_account),
        )
    except BotoCoreError as exc:
        raise AppError(HTTPStatus.BAD_GATEWAY, str(exc))


def transfer_object(account, bucket, key, item_type, action, target_account_id, target_bucket, target_prefix):
    if item_type not in {"file", "folder"}:
        raise AppError(HTTPStatus.BAD_REQUEST, "Unsupported item type")
    if action not in {"copy", "move"}:
        raise AppError(HTTPStatus.BAD_REQUEST, "Unsupported transfer action")
    if not target_bucket:
        raise AppError(HTTPStatus.BAD_REQUEST, "Target bucket is required")
    key = clean_key(key)
    if not key:
        raise AppError(HTTPStatus.BAD_REQUEST, "Source key is required")

    target_account = account_by_id(target_account_id)
    source_client = s3_client(account)
    target_client = s3_client(target_account)
    target_prefix = ensure_prefix(target_prefix)

    if item_type == "file":
        destination_key = join_s3_key(target_prefix, Path(key).name)
        ensure_distinct_transfer(account["id"], bucket, key, target_account_id, target_bucket, destination_key)
        transfer_file_between_clients(source_client, target_client, bucket, key, target_bucket, destination_key)
        if action == "move":
            s3_call(lambda: source_client.delete_object(Bucket=bucket, Key=key))
        return {"count": 1, "destinationKey": destination_key}

    source_prefix = ensure_prefix(key)
    folder_name = Path(source_prefix.rstrip("/")).name
    destination_prefix = join_s3_key(target_prefix, folder_name)
    destination_prefix = ensure_prefix(destination_prefix)
    ensure_distinct_transfer(account["id"], bucket, source_prefix, target_account_id, target_bucket, destination_prefix)

    files = list_object_files_with_client(source_client, bucket, source_prefix)
    if not files:
        s3_call(lambda: target_client.put_object(Bucket=target_bucket, Key=destination_prefix, Body=b""))
    for item in files:
        source_key = item["key"]
        relative = source_key[len(source_prefix):].lstrip("/")
        destination_key = join_s3_key(destination_prefix, relative)
        transfer_file_between_clients(source_client, target_client, bucket, source_key, target_bucket, destination_key)
    if action == "move":
        delete_prefix(source_client, bucket, source_prefix)
    return {"count": len(files), "destinationKey": destination_prefix}


def create_transfer_job(account, bucket, key, item_type, action, target_account_id, target_bucket, target_prefix):
    job_id = uuid.uuid4().hex
    job = {
        "id": job_id,
        "status": "queued",
        "jobKind": "transfer",
        "action": action,
        "accountId": account.get("id", ""),
        "bucket": bucket,
        "key": key,
        "type": item_type,
        "targetAccountId": target_account_id,
        "targetBucket": target_bucket,
        "targetPrefix": ensure_prefix(target_prefix),
        "targetPath": "",
        "totalFiles": 0,
        "completedFiles": 0,
        "totalBytes": 0,
        "completedBytes": 0,
        "currentFile": "",
        "error": "",
        "cancel": threading.Event(),
        "createdAt": time.time(),
    }
    with DOWNLOAD_JOBS_LOCK:
        DOWNLOAD_JOBS[job_id] = job
    thread = threading.Thread(target=run_transfer_job, args=(job_id, account.copy()), daemon=True)
    thread.start()
    return public_job(job)


def transfer_file_between_clients(source_client, target_client, source_bucket, source_key, target_bucket, target_key):
    copy_object_between_clients(source_client, target_client, source_bucket, source_key, target_bucket, target_key)


def transfer_job_file(job_id, source_client, target_client, source_bucket, source_key, target_bucket, target_key, *, cross_account=False):
    job = get_job(job_id)
    if job["cancel"].is_set():
        raise RuntimeError("Transfer canceled")
    update_job(job_id, currentFile=source_key)
    def callback(amount):
        current = get_job(job_id)
        if current["cancel"].is_set():
            raise RuntimeError("Transfer canceled")
        add_job_bytes(job_id, amount)

    if cross_account:
        upload_stream_between_clients(
            source_client,
            target_client,
            source_bucket,
            source_key,
            target_bucket,
            target_key,
            callback=callback,
        )
    else:
        copy_object_between_clients(
            source_client,
            target_client,
            source_bucket,
            source_key,
            target_bucket,
            target_key,
            callback=callback,
            cross_account=False,
        )
    complete_job_file(job_id, source_key)


def run_transfer_job(job_id, account):
    job = get_job(job_id)
    target_account = account_by_id(job["targetAccountId"])
    source_client = s3_client(account)
    target_client = s3_client(target_account)
    cross_account = account.get("id") != target_account.get("id")
    try:
        update_job(job_id, status="running")
        if job["type"] == "folder":
            run_folder_transfer_job(job_id, source_client, target_client, job["bucket"], job["key"], job["targetBucket"], job["targetPrefix"], job["action"], cross_account=cross_account)
        else:
            run_file_transfer_job(job_id, source_client, target_client, job["bucket"], job["key"], job["targetBucket"], job["targetPrefix"], job["action"], cross_account=cross_account)
        current = get_job(job_id)
        if current["cancel"].is_set():
            update_job(job_id, status="canceled")
        else:
            update_job(job_id, status="done", currentFile="")
    except Exception as exc:
        current = get_job(job_id)
        if current["cancel"].is_set():
            update_job(job_id, status="canceled", error="")
        else:
            update_job(job_id, status="error", error=str(exc))


def run_file_transfer_job(job_id, source_client, target_client, source_bucket, source_key, target_bucket, target_prefix, action, *, cross_account=False):
    source_key = clean_key(source_key)
    if not source_key or source_key.endswith("/"):
        raise AppError(HTTPStatus.BAD_REQUEST, "A file key is required")
    destination_key = join_s3_key(target_prefix, Path(source_key).name)
    job = get_job(job_id)
    ensure_distinct_transfer(job["accountId"], source_bucket, source_key, job["targetAccountId"], target_bucket, destination_key)
    head = s3_call(lambda: source_client.head_object(Bucket=source_bucket, Key=source_key))
    update_job(
        job_id,
        totalFiles=1,
        totalBytes=head.get("ContentLength", 0),
        targetPath=f"{target_bucket}/{destination_key}",
        currentFile=source_key,
    )
    transfer_job_file(job_id, source_client, target_client, source_bucket, source_key, target_bucket, destination_key, cross_account=cross_account)
    if action == "move":
        s3_call(lambda: source_client.delete_object(Bucket=source_bucket, Key=source_key))


def run_folder_transfer_job(job_id, source_client, target_client, source_bucket, source_prefix, target_bucket, target_prefix, action, *, cross_account=False):
    source_prefix = ensure_prefix(source_prefix)
    folder_name = Path(source_prefix.rstrip("/")).name or source_bucket
    destination_prefix = ensure_prefix(join_s3_key(target_prefix, folder_name))
    job = get_job(job_id)
    ensure_distinct_transfer(job["accountId"], source_bucket, source_prefix, job["targetAccountId"], target_bucket, destination_prefix)
    files = list_object_files_with_client(source_client, source_bucket, source_prefix)
    update_job(
        job_id,
        totalFiles=len(files),
        totalBytes=sum(item.get("size", 0) for item in files),
        targetPath=f"{target_bucket}/{destination_prefix}",
    )
    if not files:
        s3_call(lambda: target_client.put_object(Bucket=target_bucket, Key=destination_prefix, Body=b""))
    for item in files:
        if get_job(job_id)["cancel"].is_set():
            raise RuntimeError("Transfer canceled")
        source_key = item["key"]
        relative = source_key[len(source_prefix):].lstrip("/")
        destination_key = join_s3_key(destination_prefix, relative)
        transfer_job_file(job_id, source_client, target_client, source_bucket, source_key, target_bucket, destination_key, cross_account=cross_account)
    if action == "move":
        delete_prefix(source_client, source_bucket, source_prefix)


def delete_bucket_contents(client, bucket):
    paginator = client.get_paginator("list_object_versions")
    pages = s3_call(lambda: paginator.paginate(Bucket=bucket))
    batch = []
    for page in pages:
        for item in page.get("Versions", []):
            batch.append({"Key": item["Key"], "VersionId": item["VersionId"]})
            if len(batch) == 1000:
                s3_call(lambda batch=batch: client.delete_objects(Bucket=bucket, Delete={"Objects": batch}))
                batch = []
        for item in page.get("DeleteMarkers", []):
            batch.append({"Key": item["Key"], "VersionId": item["VersionId"]})
            if len(batch) == 1000:
                s3_call(lambda batch=batch: client.delete_objects(Bucket=bucket, Delete={"Objects": batch}))
                batch = []
    if batch:
        s3_call(lambda: client.delete_objects(Bucket=bucket, Delete={"Objects": batch}))
    delete_prefix(client, bucket, "")


def create_bucket_with_region(client, bucket, region):
    validate_bucket_name(bucket)
    try:
        if region == "us-east-1":
            return client.create_bucket(Bucket=bucket)
        return client.create_bucket(
            Bucket=bucket,
            CreateBucketConfiguration={"LocationConstraint": region},
        )
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code") or ""
        if code == "BucketAlreadyExists":
            raise AppError(
                HTTPStatus.CONFLICT,
                "Bucket name is already taken globally in AWS S3. Try a more unique name, for example with your team, env, and date.",
            )
        if code == "BucketAlreadyOwnedByYou":
            raise AppError(HTTPStatus.CONFLICT, "You already own a bucket with this name.")
        if code == "InvalidBucketName":
            raise AppError(
                HTTPStatus.BAD_REQUEST,
                "Invalid bucket name. Use 3-63 characters with lowercase letters, numbers, and hyphens.",
            )
        message = exc.response.get("Error", {}).get("Message") or str(exc)
        raise AppError(HTTPStatus.BAD_GATEWAY, message)
    except BotoCoreError as exc:
        raise AppError(HTTPStatus.BAD_GATEWAY, str(exc))


def validate_bucket_name(bucket):
    if not bucket:
        raise AppError(HTTPStatus.BAD_REQUEST, "Bucket name is required")
    if len(bucket) < 3 or len(bucket) > 63:
        raise AppError(HTTPStatus.BAD_REQUEST, "Bucket name must be between 3 and 63 characters")
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]*[a-z0-9]", bucket):
        raise AppError(
            HTTPStatus.BAD_REQUEST,
            "Bucket name must start and end with a letter or number and contain only lowercase letters, numbers, dots, or hyphens",
        )
    if ".." in bucket or ".-" in bucket or "-." in bucket:
        raise AppError(HTTPStatus.BAD_REQUEST, "Bucket name cannot contain invalid dot or hyphen sequences")
    if re.fullmatch(r"\d+\.\d+\.\d+\.\d+", bucket):
        raise AppError(HTTPStatus.BAD_REQUEST, "Bucket name cannot be formatted like an IP address")


def download_prefix(client, bucket, prefix, destination):
    paginator = client.get_paginator("list_objects_v2")
    pages = s3_call(lambda: paginator.paginate(Bucket=bucket, Prefix=prefix))
    tasks = []
    for page in pages:
        for item in page.get("Contents", []):
            key = item.get("Key", "")
            if not key or key.endswith("/"):
                continue
            relative = key[len(prefix):].lstrip("/") or Path(key).name
            target = destination / relative
            tasks.append((key, target))
    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = []
        for key, target in tasks:
            target.parent.mkdir(parents=True, exist_ok=True)
            futures.append(executor.submit(download_one_file, client, bucket, key, target))
        for future in as_completed(futures):
            future.result()


def download_one_file(client, bucket, key, target):
    s3_call(lambda: client.download_file(bucket, key, str(target)))


def create_download_job(account, bucket, key, item_type, destination):
    job_id = uuid.uuid4().hex
    job = {
        "id": job_id,
        "status": "queued",
        "bucket": bucket,
        "key": key,
        "type": item_type,
        "destination": str(destination),
        "targetPath": "",
        "totalFiles": 0,
        "completedFiles": 0,
        "totalBytes": 0,
        "completedBytes": 0,
        "currentFile": "",
        "error": "",
        "cancel": threading.Event(),
        "createdAt": time.time(),
    }
    with DOWNLOAD_JOBS_LOCK:
        DOWNLOAD_JOBS[job_id] = job
    thread = threading.Thread(target=run_download_job, args=(job_id, account.copy()), daemon=True)
    thread.start()
    return public_job(job)


def get_job(job_id):
    with DOWNLOAD_JOBS_LOCK:
        job = DOWNLOAD_JOBS.get(job_id)
    if not job:
        raise AppError(HTTPStatus.NOT_FOUND, "Job not found")
    return job


def public_job(job):
    with DOWNLOAD_JOBS_LOCK:
        return {key: value for key, value in job.items() if key != "cancel"}


def update_job(job_id, **values):
    with DOWNLOAD_JOBS_LOCK:
        job = DOWNLOAD_JOBS.get(job_id)
        if job:
            job.update(values)


def add_job_bytes(job_id, amount):
    with DOWNLOAD_JOBS_LOCK:
        job = DOWNLOAD_JOBS.get(job_id)
        if job:
            job["completedBytes"] += amount


def complete_job_file(job_id, key):
    with DOWNLOAD_JOBS_LOCK:
        job = DOWNLOAD_JOBS.get(job_id)
        if job:
            job["completedFiles"] += 1
            job["currentFile"] = key


def run_download_job(job_id, account):
    job = get_job(job_id)
    client = s3_client(account)
    try:
        update_job(job_id, status="running")
        if job["type"] == "folder":
            run_folder_download_job(job_id, client, job["bucket"], job["key"], Path(job["destination"]))
        else:
            run_file_download_job(job_id, client, job["bucket"], job["key"], Path(job["destination"]))
        current = get_job(job_id)
        if current["cancel"].is_set():
            update_job(job_id, status="canceled")
        else:
            update_job(job_id, status="done", currentFile="")
    except Exception as exc:
        current = get_job(job_id)
        if current["cancel"].is_set():
            update_job(job_id, status="canceled", error="")
        else:
            update_job(job_id, status="error", error=str(exc))


def run_file_download_job(job_id, client, bucket, key, destination):
    if not key or key.endswith("/"):
        raise AppError(HTTPStatus.BAD_REQUEST, "A file key is required")
    if destination.exists() and destination.is_dir():
        target = destination / (Path(key).name or "download")
    else:
        target = destination
        target.parent.mkdir(parents=True, exist_ok=True)
    head = s3_call(lambda: client.head_object(Bucket=bucket, Key=key))
    update_job(
        job_id,
        totalFiles=1,
        totalBytes=head.get("ContentLength", 0),
        targetPath=str(target),
        currentFile=key,
    )
    download_job_file(job_id, client, bucket, key, target)


def run_folder_download_job(job_id, client, bucket, prefix, destination):
    if not prefix.endswith("/"):
        prefix = f"{prefix}/"
    folder_name = Path(prefix.rstrip("/")).name or bucket
    target_root = destination / folder_name
    target_root.mkdir(parents=True, exist_ok=True)
    files = list_object_files_with_client(client, bucket, prefix)
    update_job(
        job_id,
        totalFiles=len(files),
        totalBytes=sum(item.get("size", 0) for item in files),
        targetPath=str(target_root),
    )
    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = []
        for item in files:
            if get_job(job_id)["cancel"].is_set():
                break
            key = item["key"]
            relative = key[len(prefix):].lstrip("/") or Path(key).name
            target = target_root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            futures.append(executor.submit(download_job_file, job_id, client, bucket, key, target))
        for future in as_completed(futures):
            future.result()


def download_job_file(job_id, client, bucket, key, target):
    job = get_job(job_id)
    if job["cancel"].is_set():
        raise RuntimeError("Download canceled")
    update_job(job_id, currentFile=key)

    def callback(amount):
        current = get_job(job_id)
        if current["cancel"].is_set():
            raise RuntimeError("Download canceled")
        add_job_bytes(job_id, amount)

    s3_call(lambda: client.download_file(bucket, key, str(target), Callback=callback))
    complete_job_file(job_id, key)


def list_object_files_with_client(client, bucket, prefix):
    files = []
    paginator = client.get_paginator("list_objects_v2")
    pages = s3_call(lambda: paginator.paginate(Bucket=bucket, Prefix=prefix))
    for data in pages:
        for item in data.get("Contents", []):
            key = item.get("Key", "")
            if key and not key.endswith("/"):
                files.append({"key": key, "size": item.get("Size", 0)})
    return files


def clean_key(key):
    key = unquote(key or "").lstrip("/")
    if ".." in Path(key).parts:
        raise AppError(HTTPStatus.BAD_REQUEST, "Invalid S3 key")
    return key


def history_path(bucket, key):
    stamp = time.strftime("%Y%m%d-%H%M%S")
    safe = re.sub(r"[^a-zA-Z0-9_.-]+", "_", f"{bucket}_{key}")[:160]
    return HISTORY_DIR / f"{stamp}_{safe}"


def history_label(target):
    return str(target.relative_to(DATA_DIR))


def parse_multipart_files(headers, raw_body, field_name="files"):
    content_type = headers.get("Content-Type", "")
    if not content_type.startswith("multipart/form-data"):
        raise AppError(HTTPStatus.BAD_REQUEST, "Expected multipart form upload")
    message = BytesParser(policy=email_policy).parsebytes(
        f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8") + raw_body
    )
    files = []
    for part in message.iter_parts():
        if part.get_content_disposition() != "form-data":
            continue
        if part.get_param("name", header="content-disposition") != field_name:
            continue
        filename = part.get_filename()
        if not filename:
            continue
        files.append((filename, part.get_payload(decode=True) or b""))
    return files


class Handler(BaseHTTPRequestHandler):
    server_version = "s3explorer/0.1"

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def do_DELETE(self):
        self.route("DELETE")

    def route(self, method):
        try:
            parsed = urlparse(self.path)
            if parsed.path == "/api" or parsed.path.startswith("/api/"):
                self.handle_api(method, parsed.path, parse_qs(parsed.query))
            else:
                self.serve_static(parsed.path)
        except AppError as exc:
            self.json_response({"error": exc.message}, exc.status)
        except Exception as exc:
            traceback.print_exc()
            self.json_response({"error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def handle_api(self, method, path, query):
        segments = [segment for segment in path.split("/") if segment]
        if len(segments) == 1 and segments[0] == "api":
            return self.json_response({"name": "s3explorer"})

        if segments[1:2] == ["local-defaults"] and method == "GET":
            return self.json_response({"documents": str(default_documents_dir())})

        if segments[1:2] == ["jobs"] and len(segments) == 3 and method == "GET":
            return self.json_response({"job": public_job(get_job(segments[2]))})

        if segments[1:2] == ["jobs"] and len(segments) == 4 and segments[3] == "cancel" and method == "POST":
            job = get_job(segments[2])
            job["cancel"].set()
            update_job(segments[2], status="canceling")
            return self.json_response({"ok": True, "job": public_job(job)})

        if segments[1:2] == ["accounts"]:
            return self.accounts_api(method, segments)

        if len(segments) >= 3 and segments[1] == "s3":
            account = account_by_id(segments[2])
            if len(segments) == 4 and segments[3] == "buckets" and method == "GET":
                client = s3_client(account)
                data = s3_call(lambda: client.list_buckets())
                buckets = [item["Name"] for item in data.get("Buckets", [])]
                return self.json_response({"buckets": buckets})
            if len(segments) == 4 and segments[3] == "buckets" and method == "POST":
                payload = self.read_json()
                bucket_name = str(payload.get("name") or "").strip()
                client = s3_client(account)
                create_bucket_with_region(client, bucket_name, account.get("area") or "us-east-1")
                return self.json_response({"ok": True, "bucket": bucket_name}, HTTPStatus.CREATED)
            if len(segments) >= 5 and segments[3] == "bucket":
                bucket = unquote(segments[4])
                return self.bucket_api(method, account, bucket, segments[5:], query)

        raise AppError(HTTPStatus.NOT_FOUND, "Route not found")

    def accounts_api(self, method, segments):
        accounts = load_accounts()
        if len(segments) == 2 and method == "GET":
            safe_accounts = [public_account(item) for item in accounts]
            return self.json_response({"accounts": safe_accounts})
        if len(segments) == 2 and method == "POST":
            payload = self.read_json()
            account = normalize_account(payload)
            existing_ids = {item["id"] for item in accounts}
            base_id = account["id"]
            counter = 2
            while account["id"] in existing_ids:
                account["id"] = f"{base_id}-{counter}"
                counter += 1
            accounts.append(account)
            save_accounts(accounts)
            return self.json_response({"account": public_account(account)})
        if len(segments) == 3:
            account_id = segments[2]
            index = next((i for i, item in enumerate(accounts) if item["id"] == account_id), -1)
            if index < 0:
                raise AppError(HTTPStatus.NOT_FOUND, "Account not found")
            if method == "PUT":
                payload = self.read_json()
                merged = {**accounts[index], **payload}
                if not str(payload.get("accessKey") or "").strip():
                    merged["accessKey"] = accounts[index]["accessKey"]
                updated = normalize_account(merged, account_id=account_id)
                accounts[index] = updated
                save_accounts(accounts)
                return self.json_response({"account": public_account(updated)})
            if method == "DELETE":
                del accounts[index]
                save_accounts(accounts)
                return self.json_response({"ok": True})
        raise AppError(HTTPStatus.METHOD_NOT_ALLOWED, "Method not allowed")

    def bucket_api(self, method, account, bucket, segments, query):
        if segments == ["tree"] and method == "GET":
            prefix = clean_key(query.get("prefix", [""])[0])
            token = query.get("token", [""])[0]
            return self.json_response({"tree": list_objects_tree(account, bucket, prefix, token)})

        if segments == ["object"] and method == "GET":
            key = clean_key(query.get("key", [""])[0])
            if preview_kind_for_name(key) != "text":
                raise AppError(HTTPStatus.BAD_REQUEST, "This file type is not previewable as text")
            client = s3_client(account)
            data = s3_call(lambda: client.get_object(Bucket=bucket, Key=key))
            content = data["Body"].read().decode("utf-8", errors="replace")
            return self.json_response({"key": key, "content": content})

        if segments == ["files"] and method == "GET":
            prefix = clean_key(query.get("prefix", [""])[0])
            return self.json_response({"files": list_object_files(account, bucket, prefix)})

        if segments == ["download"] and method == "GET":
            key = clean_key(query.get("key", [""])[0])
            return self.download_object(account, bucket, key)

        if segments == ["download-local"] and method == "POST":
            return self.download_local(account, bucket)

        if segments == ["object"] and method == "PUT":
            payload = self.read_json()
            key = clean_key(payload.get("key", ""))
            content = payload.get("content", "")
            target = history_path(bucket, key)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
            client = s3_client(account)
            s3_call(lambda: client.put_object(Bucket=bucket, Key=key, Body=content.encode("utf-8")))
            return self.json_response({"ok": True, "history": history_label(target)})

        if segments == ["delete"] and method == "POST":
            payload = self.read_json()
            if payload.get("confirm") != "delete":
                raise AppError(HTTPStatus.BAD_REQUEST, 'Please type "delete" to confirm')
            key = clean_key(payload.get("key", ""))
            item_type = payload.get("type")
            client = s3_client(account)
            if item_type == "folder":
                delete_prefix(client, bucket, key)
            else:
                s3_call(lambda: client.delete_object(Bucket=bucket, Key=key))
            return self.json_response({"ok": True})

        if segments == ["folder"] and method == "POST":
            payload = self.read_json()
            parent = clean_key(payload.get("parent", ""))
            name = clean_key(payload.get("name", "")).strip("/")
            if not name:
                raise AppError(HTTPStatus.BAD_REQUEST, "Folder name is required")
            key = f"{parent.rstrip('/')}/{name}/".lstrip("/")
            client = s3_client(account)
            s3_call(lambda: client.put_object(Bucket=bucket, Key=key, Body=b""))
            return self.json_response({"ok": True, "key": key})

        if segments == ["transfer"] and method == "POST":
            payload = self.read_json()
            job = create_transfer_job(
                account,
                bucket,
                payload.get("key", ""),
                payload.get("type", ""),
                payload.get("action", ""),
                str(payload.get("targetAccountId") or "").strip(),
                str(payload.get("targetBucket") or "").strip(),
                payload.get("targetPrefix", ""),
            )
            return self.json_response({"ok": True, "job": job}, HTTPStatus.ACCEPTED)

        if segments == ["upload"] and method == "POST":
            return self.upload_files(account, bucket, query)

        if segments == ["bucket"] and method == "DELETE":
            payload = self.read_json()
            if payload.get("confirm") != "delete":
                raise AppError(HTTPStatus.BAD_REQUEST, 'Please type "delete" to confirm')
            client = s3_client(account)
            delete_bucket_contents(client, bucket)
            s3_call(lambda: client.delete_bucket(Bucket=bucket))
            return self.json_response({"ok": True})

        raise AppError(HTTPStatus.NOT_FOUND, "Bucket route not found")

    def download_object(self, account, bucket, key):
        if not key or key.endswith("/"):
            raise AppError(HTTPStatus.BAD_REQUEST, "A file key is required")
        client = s3_client(account)
        data = s3_call(lambda: client.get_object(Bucket=bucket, Key=key))
        body = data["Body"]
        content_type = mimetypes.guess_type(key)[0] or "application/octet-stream"
        filename = Path(key).name or "download"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(data.get("ContentLength", 0)))
        self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(filename)}")
        self.end_headers()
        while True:
            chunk = body.read(1024 * 1024)
            if not chunk:
                break
            self.wfile.write(chunk)

    def download_local(self, account, bucket):
        payload = self.read_json()
        key = clean_key(payload.get("key", ""))
        item_type = payload.get("type")
        destination = local_destination(payload.get("destination", ""))
        if item_type not in {"file", "folder"}:
            raise AppError(HTTPStatus.BAD_REQUEST, "Download type must be file or folder")
        job = create_download_job(account, bucket, key, item_type, destination)
        return self.json_response({"ok": True, "job": job})

    def upload_files(self, account, bucket, query):
        prefix = clean_key(query.get("prefix", [""])[0]).rstrip("/")
        length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(length)
        files = parse_multipart_files(self.headers, raw_body)
        uploaded = []
        client = s3_client(account)
        for filename, payload in files:
            relative_name = clean_key(filename)
            key = f"{prefix}/{relative_name}".lstrip("/") if prefix else relative_name
            s3_call(lambda payload=payload, key=key: client.upload_fileobj(io.BytesIO(payload), bucket, key))
            uploaded.append(key)
        return self.json_response({"ok": True, "uploaded": uploaded})

    def serve_static(self, path):
        path = unquote(path)
        if path == "/":
            path = "/index.html"
        rel = posixpath.normpath(path).lstrip("/")
        if rel.startswith("../"):
            raise AppError(HTTPStatus.BAD_REQUEST, "Invalid path")
        target = STATIC_DIR / rel
        if not target.exists() or not target.is_file():
            raise AppError(HTTPStatus.NOT_FOUND, "Not found")
        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(target.stat().st_size))
        self.end_headers()
        with target.open("rb") as fh:
            shutil.copyfileobj(fh, self.wfile)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def json_response(self, data, status=HTTPStatus.OK):
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def normalize_account(payload, account_id=None):
    name = str(payload.get("name") or "").strip()
    if not name:
        raise AppError(HTTPStatus.BAD_REQUEST, "Account name is required")
    key_id = str(payload.get("keyId") or "").strip()
    access_key = str(payload.get("accessKey") or "").strip()
    if not key_id or not access_key:
        raise AppError(HTTPStatus.BAD_REQUEST, "Key id and access key are required")
    area = str(payload.get("area") or "us-east-1").strip()
    output = str(payload.get("format") or "json").strip().lower()
    if output not in {"json", "txt", "text"}:
        raise AppError(HTTPStatus.BAD_REQUEST, "Format must be txt or json")
    return {
        "id": account_id or slugify(name),
        "name": name,
        "keyId": key_id,
        "accessKey": access_key,
        "area": area,
        "format": "txt" if output == "text" else output,
    }


def mask_secret(secret):
    if len(secret) <= 8:
        return "*" * len(secret)
    return f"{secret[:4]}{'*' * (len(secret) - 8)}{secret[-4:]}"


def local_destination(value):
    raw = str(value or "").strip()
    if not raw:
        raise AppError(HTTPStatus.BAD_REQUEST, "Destination path is required")
    expanded = Path(os.path.expandvars(os.path.expanduser(raw))).resolve()
    home = Path.home().resolve()
    tmp = Path("/tmp").resolve()
    if expanded != home and home not in expanded.parents and expanded != tmp and tmp not in expanded.parents:
        raise AppError(HTTPStatus.BAD_REQUEST, f"Destination must be under {home} or /tmp")
    return expanded


def default_documents_dir():
    documents = Path.home() / "Documents"
    return documents if documents.exists() else Path.home()


def public_account(account):
    public = {key: value for key, value in account.items() if key != "accessKey"}
    public["accessKeyMasked"] = mask_secret(account.get("accessKey", ""))
    return public


def open_browser_later(url):
    timer = threading.Timer(0.8, lambda: webbrowser.open(url))
    timer.daemon = True
    timer.start()


def main():
    parser = argparse.ArgumentParser(description="Run the s3explorer local web server")
    parser.add_argument("--host", default="127.0.0.1", help="Host interface to bind to")
    parser.add_argument("--port", type=int, default=8000, help="Port to listen on")
    parser.add_argument("--no-browser", action="store_true", help="Do not automatically open the app in a browser")
    args = parser.parse_args()
    ensure_data()
    host = args.host
    port = args.port
    server = ThreadingHTTPServer((host, port), Handler)
    url = f"http://{host}:{port}"
    if not args.no_browser:
        open_browser_later(url)
    print(f"s3explorer running at {url}")
    print(f"static assets: {STATIC_DIR}")
    print(f"user data: {DATA_DIR}")
    server.serve_forever()


if __name__ == "__main__":
    main()
