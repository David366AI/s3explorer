# s3explorer

![Python](https://img.shields.io/badge/python-3.10%2B-3776AB?logo=python&logoColor=white)
![AWS S3](https://img.shields.io/badge/aws-s3-FF9900?logo=amazonaws&logoColor=white)
![boto3](https://img.shields.io/badge/boto3-powered-4B8BBE)
![License](https://img.shields.io/badge/license-MIT-green)

A local-first AWS S3 browser and editor for developers who need a fast way to inspect buckets, browse objects as a tree, edit text files, and move files between S3 and their machine.

Unlike heavyweight cloud consoles or Electron desktop apps, `s3explorer` runs as a small Python server with a browser UI. It uses the Python standard library for the web layer and `boto3` for S3 operations.

## Screenshot

![s3explorer screenshot](s3explorer.jpg)

Keywords: AWS S3 browser, S3 explorer, S3 file editor, S3 bucket viewer, local S3 admin tool, lightweight S3 GUI.

## Highlights

- Lightweight local web app with no frontend build step
- Multi-account AWS S3 browsing from one interface
- Tree-based bucket navigation with lazy loading
- In-browser editing for common text and config files
- Local history snapshots before overwrite
- Drag-and-drop upload for files and folders
- Safe delete confirmation for files and prefixes
- Local download workflow with transfer progress and cancel support

## Table of Contents

- [Why s3explorer](#why-s3explorer)
- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Usage](#usage)
- [Permissions](#permissions)
- [Data Storage](#data-storage)
- [Security Notes](#security-notes)
- [Project Structure](#project-structure)
- [Use Cases](#use-cases)
- [FAQ](#faq)
- [Limitations](#limitations)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## Why s3explorer

Working with S3 often means switching between the AWS Console, the CLI, and local files. `s3explorer` brings those steps together in one place:

- Browse buckets and prefixes in a tree view.
- Open common text-based files directly from S3.
- Edit and save config files back to S3 with a local history snapshot.
- Drag and drop files or full folders into a target prefix.
- Download files and folders to your machine.
- Manage multiple AWS accounts from one lightweight local tool.

This project is a good fit for teams working with:

- application config stored in S3
- ETL or data pipeline definitions
- staging and production environment files
- log, JSON, YAML, and script inspection
- quick operational fixes without building a larger internal tool

## Features

### AWS account management

- Imports profiles from `$HOME/.aws/credentials` and `$HOME/.aws/config` on first start when `data/accounts.json` is missing or empty.
- Create, edit, and delete local account entries.
- Stores account name, access key ID, secret access key, region, and output format.
- Masks secrets in the UI when listing saved accounts.

### Bucket and object browsing

- Lists all buckets for the selected account.
- Supports creating new buckets from the UI.
- Supports bucket deletion with explicit `delete` confirmation.
- Displays bucket contents as an expandable tree.
- Supports lazy loading and pagination for larger prefixes.
- Lets you select any file or folder and inspect its path and size.

### File preview and editing

- Opens common text-based files directly from S3.
- Previews common image formats directly in the browser.
- Includes inline syntax highlighting for JSON, YAML, Python, C, C++, and Java.
- Supports editing and saving back to S3 from the browser.
- Writes a local timestamped backup to `data/history/` before upload.

Supported text extensions include:

`txt`, `xml`, `json`, `config`, `properties`, `conf`, `cfg`, `ini`, `yaml`, `yml`, `md`, `csv`, `log`, `sh`, `env`, `tpl`, `script`, `py`, `c`, `go`, `cpp`, `cc`, `cxx`, `h`, `hpp`, `java`

Supported image preview extensions include:

`png`, `jpg`, `jpeg`, `bmp`, `gif`

### Safe file operations

- Delete files or folders only after typing `delete` as confirmation.
- Create empty folders under the currently selected prefix.
- Download individual files directly from the browser.
- Download folders and large transfers through a local server-side job flow with progress tracking.
- Cancel uploads and downloads in progress.

### Drag-and-drop uploads

- Drop files directly into the selected folder.
- Drop full directories and preserve relative paths.
- Shows upload progress for both single-file and multi-file transfers.

## Installation

### Requirements

- Python 3.10+
- AWS credentials with permission to list buckets and read or write objects as needed

### Install dependencies

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

If you do not want a virtual environment, this also works:

```bash
python -m pip install -r requirements.txt
```

## Quick Start

Start the local server:

```bash
python server.py
```

Open:

```text
http://127.0.0.1:8000
```

You can also override the host and port:

```bash
python server.py --host 127.0.0.1 --port 8001
```

## Usage

### 1. Load or add an AWS account

On first launch, `s3explorer` tries to import profiles from your local AWS config files.

If you want to add an account manually, use the account panel and provide:

- profile name
- key ID
- access key
- region
- output format

### 2. Select a bucket

After choosing an account, the app loads all accessible buckets. Click a bucket to open its object tree.

### 3. Browse and inspect objects

- Click folders to expand prefixes.
- Click supported text files to preview their content.
- Click supported image files to preview them directly in the viewer.
- Select any file or folder to enable download or delete actions.

Supported image preview formats:

`png`, `jpg`, `jpeg`, `bmp`, `gif`

### 4. Edit a text file

For supported text formats:

1. Select the file.
2. Click `Edit`.
3. Update the content.
4. Click `Save`.

Before the new content is uploaded to S3, a local snapshot is stored under `data/history/`.

### 5. Upload files or folders

Drag files or directories from your desktop into the main workspace. If a folder is selected, uploads go into that prefix. If a file is selected, uploads go into its parent folder.

### 6. Download files or folders

- File downloads can use the browser save dialog when supported.
- Folder downloads use the local server workflow and save to a directory on your machine.
- Long-running downloads show progress and can be canceled.

## Permissions

The exact AWS permissions depend on how you use the tool. For read-only browsing, listing and object reads are enough. For editing, uploading, deleting, and folder creation, write permissions are also required.

A minimal example policy for a specific bucket looks like this:

```json
{
	"Version": "2012-10-17",
	"Statement": [
		{
			"Effect": "Allow",
			"Action": [
				"s3:ListAllMyBuckets",
				"s3:GetBucketLocation"
			],
			"Resource": "*"
		},
		{
			"Effect": "Allow",
			"Action": [
				"s3:ListBucket"
			],
			"Resource": "arn:aws:s3:::YOUR_BUCKET"
		},
		{
			"Effect": "Allow",
			"Action": [
				"s3:GetObject",
				"s3:PutObject",
				"s3:DeleteObject"
			],
			"Resource": "arn:aws:s3:::YOUR_BUCKET/*"
		}
	]
}
```

For production use, narrow permissions to the buckets and prefixes your team actually needs.

## Data Storage

The project keeps a small amount of local state:

- `data/accounts.json`: saved account definitions
- `data/history/`: timestamped backups of files before they are overwritten in S3

These files are intentionally local and are already ignored by `.gitignore`.

## Security Notes

- This is a local tool intended to run on a trusted machine.
- AWS secrets are stored locally in `data/accounts.json` if you create or edit accounts in the UI.
- Local downloads are restricted to paths under your home directory or `/tmp`.
- Destructive delete operations require explicit text confirmation.

If your workflow already uses `$HOME/.aws/credentials` and `$HOME/.aws/config`, prefer importing those profiles instead of duplicating credentials unnecessarily.

## Project Structure

```text
.
├── server.py           # Python HTTP server and S3 API handlers
├── requirements.txt    # Python dependencies
├── static/
│   ├── index.html      # UI shell
│   ├── app.js          # Client-side application logic
│   └── styles.css      # Styles
└── data/
    ├── accounts.json   # Local account storage
    └── history/        # Local edit history snapshots
```

## Use Cases

- Review and patch configuration files in S3 without using the AWS Console.
- Compare and update environment-specific config in staging or production buckets.
- Browse data pipeline artifacts and operational files more quickly than with CLI-only workflows.
- Provide a lightweight internal S3 admin tool for engineers and operators.

## FAQ

### Is this a hosted service?

No. `s3explorer` is a local tool. You run `server.py` on your own machine and open it in your browser.

### Does it upload files directly from the browser to S3?

The browser sends files to the local Python server, and the server performs the S3 upload through `boto3`.

### Are my AWS credentials sent anywhere else?

No external service is involved in the project itself. Credentials are used locally by your running server process to call AWS APIs.

### Can I use it for binary assets?

You can browse, upload, download, and delete binary files, but inline preview and editing are intended for supported text formats.

### Is this meant for multi-user deployment?

Not in its current form. The project is designed as a trusted local utility rather than a shared authenticated web service.

## Limitations

- This project focuses on S3 object browsing and editing, not full AWS resource management.
- Binary file preview is not supported.
- Authentication is based on local credentials you provide or import.
- The app is designed for trusted local use rather than multi-user deployment.

## Development

Install dependencies and run the server locally:

```bash
python -m pip install -r requirements.txt
python server.py
```

There is no frontend build step.

## Contributing

Issues and pull requests are welcome.

Useful contribution areas:

- better error handling for AWS edge cases
- UI improvements for very large buckets
- additional text preview formats
- tests for S3 operations and local job handling
- packaging and release automation

## License

This project is licensed under the MIT License. See `LICENSE` for details.
