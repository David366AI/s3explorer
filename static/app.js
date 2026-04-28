const state = {
  accounts: [],
  accountId: "",
  bucket: "",
  selected: null,
  contextMenuNode: null,
  deleteTarget: null,
  editing: false,
  accountEditId: "",
  currentContent: "",
  transferAbortController: null,
  activeXhrs: new Set(),
  transferClosing: false,
  currentJobId: "",
  jobPollTimer: null,
  defaultDocumentsPath: "",
  transferAction: "copy",
  transferTarget: null,
  transferAccountId: "",
  transferBucket: "",
  transferPrefix: "",
  transferTree: null,
  transferRequestId: 0,
};

const $ = (id) => document.getElementById(id);

const els = {
  accountSelect: $("accountSelect"),
  editAccountBtn: $("editAccountBtn"),
  deleteSelectedAccountBtn: $("deleteSelectedAccountBtn"),
  newBucketBtn: $("newBucketBtn"),
  deleteBucketBtn: $("deleteBucketBtn"),
  accountDialog: $("accountDialog"),
  accountForm: $("accountForm"),
  accountFormTitle: $("accountFormTitle"),
  accountName: $("accountName"),
  keyId: $("keyId"),
  accessKey: $("accessKey"),
  area: $("area"),
  format: $("format"),
  currentBucket: $("currentBucket"),
  bucketList: $("bucketList"),
  tree: $("tree"),
  selectedType: $("selectedType"),
  selectedName: $("selectedName"),
  preview: $("preview"),
  editorWrap: $("editorWrap"),
  editorHighlight: $("editorHighlight"),
  editor: $("editor"),
  editBtn: $("editBtn"),
  saveBtn: $("saveBtn"),
  downloadBtn: $("downloadBtn"),
  deleteBtn: $("deleteBtn"),
  deleteAccountBtn: $("deleteAccountBtn"),
  deleteDialog: $("deleteDialog"),
  deleteForm: $("deleteForm"),
  deleteMessage: $("deleteMessage"),
  deleteConfirmInput: $("deleteConfirmInput"),
  confirmDeleteBtn: $("confirmDeleteBtn"),
  uploadDialog: $("uploadDialog"),
  uploadTitle: $("uploadTitle"),
  uploadMessage: $("uploadMessage"),
  uploadProgressBar: $("uploadProgressBar"),
  uploadDetail: $("uploadDetail"),
  cancelTransferBtn: $("cancelTransferBtn"),
  localDownloadDialog: $("localDownloadDialog"),
  localDownloadForm: $("localDownloadForm"),
  localDownloadMessage: $("localDownloadMessage"),
  localDownloadPath: $("localDownloadPath"),
  transferDialog: $("transferDialog"),
  transferForm: $("transferForm"),
  transferDialogTitle: $("transferDialogTitle"),
  transferSource: $("transferSource"),
  targetAccountSelect: $("targetAccountSelect"),
  targetBucketSelect: $("targetBucketSelect"),
  transferTargetPath: $("transferTargetPath"),
  transferTree: $("transferTree"),
  confirmTransferBtn: $("confirmTransferBtn"),
  errorDialog: $("errorDialog"),
  errorDialogTitle: $("errorDialogTitle"),
  errorDialogMessage: $("errorDialogMessage"),
  contextMenu: $("contextMenu"),
  dropZone: $("dropZone"),
  toast: $("toast"),
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body instanceof FormData ? {} : { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

function toast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.className = `toast${isError ? " error" : ""}`;
  els.toast.hidden = false;
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, isError ? 6000 : 2600);
}

function showErrorDialog(message, title = "Operation Failed") {
  els.errorDialogTitle.textContent = title;
  els.errorDialogMessage.textContent = message || "Unknown error";
  if (!els.errorDialog.open) {
    els.errorDialog.showModal();
  }
}

function closeErrorDialog() {
  if (els.errorDialog.open) {
    els.errorDialog.close();
  }
}

async function loadAccounts() {
  await loadLocalDefaults();
  const data = await api("/api/accounts");
  state.accounts = data.accounts;
  if (state.accountId && !state.accounts.some((account) => account.id === state.accountId)) {
    state.accountId = "";
  }
  renderAccounts();
  if (!state.accountId && state.accounts.length) {
    await selectAccount(state.accounts[0].id);
  } else if (!state.accounts.length) {
    clearAccountContext();
  }
}

async function loadLocalDefaults() {
  if (state.defaultDocumentsPath) return;
  const data = await api("/api/local-defaults");
  state.defaultDocumentsPath = data.documents || "";
}

function hideContextMenu() {
  state.contextMenuNode = null;
  els.contextMenu.hidden = true;
}

function openContextMenu(node, x, y) {
  if (!node?.key) return;
  state.contextMenuNode = node;
  els.contextMenu.hidden = false;
  els.contextMenu.style.left = "0px";
  els.contextMenu.style.top = "0px";
  window.requestAnimationFrame(() => {
    const rect = els.contextMenu.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
    els.contextMenu.style.left = `${left}px`;
    els.contextMenu.style.top = `${top}px`;
  });
}

function renderAccounts() {
  els.accountSelect.innerHTML = '<option value="">Select account</option>';
  if (!state.accounts.length) {
    els.editAccountBtn.disabled = true;
    els.deleteSelectedAccountBtn.disabled = true;
    els.newBucketBtn.disabled = true;
    els.deleteBucketBtn.disabled = true;
    return;
  }
  state.accounts.forEach((account) => {
    const option = document.createElement("option");
    option.value = account.id;
    option.textContent = account.name;
    els.accountSelect.appendChild(option);
  });
  els.accountSelect.value = state.accountId;
  els.editAccountBtn.disabled = !state.accountId;
  els.deleteSelectedAccountBtn.disabled = !state.accountId;
  els.newBucketBtn.disabled = !state.accountId;
  els.deleteBucketBtn.disabled = !state.accountId || !state.bucket;
}

async function selectAccount(accountId) {
  hideContextMenu();
  if (!accountId) {
    clearAccountContext();
    renderAccounts();
    return;
  }
  state.accountId = accountId;
  state.bucket = "";
  state.selected = null;
  state.deleteTarget = null;
  els.currentBucket.textContent = "Select a bucket";
  renderAccounts();
  resetViewer();
  await loadBuckets();
}

function clearAccountContext() {
  hideContextMenu();
  state.accountId = "";
  state.bucket = "";
  state.selected = null;
  state.deleteTarget = null;
  els.accountSelect.value = "";
  els.bucketList.innerHTML = "";
  els.bucketList.className = "bucket-list empty";
  els.bucketList.textContent = "Select an account.";
  els.currentBucket.textContent = "Select a bucket";
  els.tree.textContent = "Select a bucket to browse files.";
  els.tree.className = "tree empty";
  resetViewer();
}

function currentAccount() {
  return state.accounts.find((account) => account.id === state.accountId);
}

function fillAccountForm(account) {
  els.accountFormTitle.textContent = account ? "Edit Account" : "New Account";
  els.deleteAccountBtn.hidden = !account;
  els.accountName.value = account?.name || "";
  els.keyId.value = account?.keyId || "";
  els.accessKey.value = "";
  els.area.value = account?.area || "us-east-1";
  els.format.value = account?.format || "json";
}

function openAccountDialog(account = null) {
  state.accountEditId = account?.id || "";
  fillAccountForm(account);
  els.accountDialog.showModal();
  els.accountName.focus();
}

function closeAccountDialog() {
  state.accountEditId = "";
  els.accountDialog.close();
}

async function saveAccount(event) {
  event.preventDefault();
  const payload = {
    name: els.accountName.value,
    keyId: els.keyId.value,
    accessKey: els.accessKey.value,
    area: els.area.value,
    format: els.format.value,
  };
  const path = state.accountEditId ? `/api/accounts/${encodeURIComponent(state.accountEditId)}` : "/api/accounts";
  const method = state.accountEditId ? "PUT" : "POST";
  const data = await api(path, { method, body: JSON.stringify(payload) });
  toast("Account saved");
  state.accountId = data.account.id;
  closeAccountDialog();
  await loadAccounts();
  await selectAccount(state.accountId);
}

async function deleteAccount() {
  const account = state.accounts.find((item) => item.id === (state.accountEditId || state.accountId));
  if (!account) return;
  if (!window.confirm(`Delete account ${account.name}?`)) return;
  await api(`/api/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
  state.accountId = "";
  state.bucket = "";
  fillAccountForm(null);
  if (els.accountDialog.open) closeAccountDialog();
  await loadAccounts();
  toast("Account deleted");
}

async function loadBuckets() {
  els.bucketList.innerHTML = "";
  els.bucketList.className = "bucket-list empty";
  els.bucketList.textContent = state.accountId ? "Loading buckets..." : "Select an account.";
  els.currentBucket.textContent = "Select a bucket";
  els.tree.textContent = "Loading buckets...";
  els.tree.className = "tree empty";
  if (!state.accountId) return;
  try {
    const data = await api(`/api/s3/${encodeURIComponent(state.accountId)}/buckets`);
    renderBuckets(data.buckets);
    els.tree.textContent = data.buckets.length ? "Select a bucket." : "This account has no buckets.";
  } catch (error) {
    toast(error.message, true);
    els.bucketList.textContent = "Failed to load buckets.";
    els.tree.textContent = "Failed to load buckets.";
  }
}

function renderBuckets(buckets) {
  els.bucketList.innerHTML = "";
  els.deleteBucketBtn.disabled = !state.accountId || !state.bucket;
  if (!buckets.length) {
    els.bucketList.className = "bucket-list empty";
    els.bucketList.textContent = "No buckets found.";
    els.deleteBucketBtn.disabled = true;
    return;
  }
  els.bucketList.className = "bucket-list";
  buckets.forEach((bucket) => {
    const button = document.createElement("button");
    button.className = `bucket-item${bucket === state.bucket ? " active" : ""}`;
    button.textContent = bucket;
    button.addEventListener("click", () => selectBucket(bucket));
    els.bucketList.appendChild(button);
  });
}

async function selectBucket(bucket) {
  hideContextMenu();
  state.bucket = bucket;
  state.deleteTarget = null;
  [...els.bucketList.querySelectorAll(".bucket-item")].forEach((item) => {
    item.classList.toggle("active", item.textContent === bucket);
  });
  els.deleteBucketBtn.disabled = !state.bucket;
  await loadTree();
}

async function loadTree() {
  hideContextMenu();
  state.selected = null;
  resetViewer();
  if (!state.bucket) {
    els.currentBucket.textContent = "Select a bucket";
    els.tree.textContent = "Select a bucket to browse files.";
    els.tree.className = "tree empty";
    return;
  }
  els.currentBucket.textContent = state.bucket;
  els.tree.textContent = "Loading object tree...";
  els.tree.className = "tree empty";
  try {
    const data = await api(`/api/s3/${encodeURIComponent(state.accountId)}/bucket/${encodeURIComponent(state.bucket)}/tree`);
    els.tree.className = "tree";
    els.tree.innerHTML = "";
    els.tree.appendChild(renderNode(data.tree, true));
  } catch (error) {
    toast(error.message, true);
    els.tree.textContent = "Failed to load object tree.";
  }
}

function renderNode(node, expanded = false) {
  const wrapper = document.createElement("div");
  const row = document.createElement("div");
  row.className = "tree-node";
  row.dataset.key = node.key;
  row.dataset.type = node.type;

  const icon = document.createElement("span");
  icon.textContent = node.type === "folder" ? "▸" : "•";
  const label = document.createElement("span");
  label.className = "tree-label";
  label.textContent = node.name || state.bucket;
  row.append(icon, label);
  wrapper.appendChild(row);

  const children = document.createElement("div");
  children.className = "tree-children";
  children.hidden = !expanded;
  renderChildren(node, children);
  wrapper.appendChild(children);

  row.addEventListener("click", async (event) => {
    event.stopPropagation();
    hideContextMenu();
    selectNode(row, node);
    if (node.type === "folder") {
      if (!node.loaded) {
        await loadTreeChildren(node, children);
      }
      children.hidden = !children.hidden;
      icon.textContent = children.hidden ? "▸" : "▾";
    } else if (node.viewable) {
      await previewNode(node);
    } else {
      els.preview.textContent = "This file type cannot be previewed directly.";
      state.currentContent = "";
    }
  });

  row.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!node.key) {
      hideContextMenu();
      return;
    }
    selectNode(row, node);
    openContextMenu(node, event.clientX, event.clientY);
  });

  if (expanded && node.type === "folder") icon.textContent = "▾";
  return wrapper;
}

function renderChildren(node, container) {
  container.innerHTML = "";
  (node.children || []).forEach((child) => container.appendChild(renderNode(child)));
  if (node.hasMore) {
    const button = document.createElement("button");
    button.className = "show-more";
    button.textContent = "Show more";
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      button.disabled = true;
      button.textContent = "Loading...";
      await loadTreeChildren(node, container, true);
    });
    container.appendChild(button);
  }
}

async function loadTreeChildren(node, container, append = false) {
  const token = append ? node.nextToken || "" : "";
  const path = `/api/s3/${encodeURIComponent(state.accountId)}/bucket/${encodeURIComponent(state.bucket)}/tree?prefix=${encodeURIComponent(node.key || "")}&token=${encodeURIComponent(token)}`;
  const data = await api(path);
  const incoming = data.tree;
  node.loaded = true;
  node.hasMore = incoming.hasMore;
  node.nextToken = incoming.nextToken;
  node.children = append ? [...(node.children || []), ...(incoming.children || [])] : incoming.children || [];
  renderChildren(node, container);
}

function selectNode(row, node) {
  document.querySelectorAll(".tree-node.active").forEach((item) => item.classList.remove("active"));
  row.classList.add("active");
  state.selected = node;
  state.editing = false;
  els.editorWrap.hidden = true;
  els.preview.hidden = false;
  els.saveBtn.hidden = true;
  els.selectedType.textContent = node.type === "folder" ? "Folder" : "File";
  els.selectedName.innerHTML = selectedTitleHtml(node);
  els.deleteBtn.disabled = !node.key;
  els.downloadBtn.disabled = !node.key;
  els.editBtn.disabled = node.type !== "file" || node.previewKind !== "text";
}

function selectedTitleHtml(node) {
  if (node.type === "file") {
    return `${escapeHtml(node.key)} <span class="file-size">(${formatBytes(node.size || 0)})</span>`;
  }
  return escapeHtml(node.key || state.bucket);
}

async function previewNode(node) {
  if (node.previewKind === "image") {
    previewImage(node);
    return;
  }
  await viewFile(node);
}

async function viewFile(node) {
  els.preview.textContent = "Loading file...";
  try {
    const data = await api(`/api/s3/${encodeURIComponent(state.accountId)}/bucket/${encodeURIComponent(state.bucket)}/object?key=${encodeURIComponent(node.key)}`);
    state.currentContent = data.content;
    renderHighlighted(els.preview, data.content, node.key);
    els.editor.value = data.content;
    renderHighlighted(els.editorHighlight, data.content, node.key);
  } catch (error) {
    toast(error.message, true);
    els.preview.textContent = "Failed to load file.";
    state.currentContent = "";
  }
}

function previewImage(node) {
  state.currentContent = "";
  const src = downloadUrl(node.key);
  els.preview.innerHTML = `<div class="preview-image-wrap"><img class="preview-image" src="${escapeHtml(src)}" alt="${escapeHtml(node.name || node.key)}" /></div>`;
}

function beginEdit() {
  if (!state.selected) return;
  state.editing = true;
  els.editor.value = state.currentContent;
  renderHighlighted(els.editorHighlight, state.currentContent, state.selected.key);
  els.preview.hidden = true;
  els.editorWrap.hidden = false;
  els.saveBtn.hidden = false;
  els.editor.focus();
}

async function saveFile() {
  if (!state.selected) return;
  const payload = { key: state.selected.key, content: els.editor.value };
  await api(`/api/s3/${encodeURIComponent(state.accountId)}/bucket/${encodeURIComponent(state.bucket)}/object`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  state.currentContent = els.editor.value;
  renderHighlighted(els.preview, state.currentContent, state.selected.key);
  els.preview.hidden = false;
  els.editorWrap.hidden = true;
  els.saveBtn.hidden = true;
  state.editing = false;
  toast("File saved to S3 and local history");
}

async function downloadSelected() {
  if (!state.selected) return;
  if (state.selected.type === "file") {
    try {
      await downloadFileWithPicker(state.selected.key, state.selected.name || fileNameFromKey(state.selected.key));
    } catch (error) {
      if (isPickerError(error)) openLocalDownloadDialog();
      else throw error;
    }
    return;
  }
  openLocalDownloadDialog("Folder downloads are saved by the local server.");
}

async function downloadFileWithPicker(key, suggestedName) {
  const url = downloadUrl(key);
  if (!window.showSaveFilePicker) {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = suggestedName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    toast("Download started");
    return;
  }
  const handle = await window.showSaveFilePicker({ suggestedName });
  showUploadProgress("Downloading File");
  await streamDownloadToFile(url, handle, key);
  updateUploadProgress(100, "Download complete", key);
  finishTransferSoon();
}

async function downloadFolderWithPicker(prefix) {
  if (!window.showDirectoryPicker) {
    openLocalDownloadDialog();
    return;
  }
  const data = await api(`/api/s3/${encodeURIComponent(state.accountId)}/bucket/${encodeURIComponent(state.bucket)}/files?prefix=${encodeURIComponent(prefix)}`);
  const files = data.files || [];
  if (!files.length) {
    showUploadProgress("Downloading Folder");
    updateUploadProgress(100, "No files found", prefix);
    finishTransferSoon();
    return;
  }
  if (hasBrowserBlockedPath(files, prefix)) {
    openLocalDownloadDialog("This folder contains hidden or system-style paths that the browser cannot write safely.");
    return;
  }
  const directory = await window.showDirectoryPicker({ mode: "readwrite" });
  showUploadProgress("Downloading Folder");
  let completed = 0;
  await runWithConcurrency(files, 5, async (file) => {
    throwIfTransferCanceled();
    const relativePath = file.key.slice(prefix.length).replace(/^\/+/, "") || fileNameFromKey(file.key);
    updateUploadProgress(Math.round((completed / files.length) * 100), `${completed} / ${files.length} files downloaded`, relativePath);
    const blob = await fetchBlob(downloadUrl(file.key), state.transferAbortController?.signal);
    throwIfTransferCanceled();
    await writeBlobToDirectory(directory, relativePath, blob);
    completed += 1;
    updateUploadProgress(Math.round((completed / files.length) * 100), `${completed} / ${files.length} files downloaded`, relativePath);
  });
  finishTransferSoon();
}

async function runWithConcurrency(items, limit, worker) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      throwIfTransferCanceled();
      const item = items[nextIndex];
      nextIndex += 1;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

function isPickerError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return ["system files", "notallowed", "not allowed", "security"].some((part) => message.includes(part));
}

function hasBrowserBlockedPath(files, prefix) {
  return files.some((file) => {
    const relativePath = file.key.slice(prefix.length).replace(/^\/+/, "") || fileNameFromKey(file.key);
    return relativePath.split("/").some((part) => part.startsWith("."));
  });
}

function openLocalDownloadDialog(reason = "") {
  if (!state.selected) return;
  const defaultPath = state.defaultDocumentsPath || "";
  const fallbackMessage = state.selected.type === "folder"
    ? `Browser folder access failed. Download ${state.selected.key} on the local server instead.`
    : `Browser save access failed. Download ${state.selected.key} on the local server instead.`;
  els.localDownloadMessage.textContent = reason ? `${reason} ${fallbackMessage}` : fallbackMessage;
  els.localDownloadPath.value = defaultPath;
  els.localDownloadDialog.showModal();
  els.localDownloadPath.focus();
}

function closeLocalDownloadDialog() {
  els.localDownloadDialog.close();
}

async function submitLocalDownload(event) {
  event.preventDefault();
  if (!state.selected) return;
  const destination = els.localDownloadPath.value.trim();
  if (!destination) return;
  els.localDownloadDialog.close();
  showUploadProgress(state.selected.type === "folder" ? "Downloading Folder" : "Downloading File");
  const data = await api(`/api/s3/${encodeURIComponent(state.accountId)}/bucket/${encodeURIComponent(state.bucket)}/download-local`, {
    method: "POST",
    signal: state.transferAbortController?.signal,
    body: JSON.stringify({ key: state.selected.key, type: state.selected.type, destination }),
  });
  state.currentJobId = data.job.id;
  updateJobProgress(data.job);
  pollDownloadJob();
}

async function pollDownloadJob() {
  if (!state.currentJobId) return;
  try {
    const data = await api(`/api/jobs/${encodeURIComponent(state.currentJobId)}`);
    const job = data.job;
    updateJobProgress(job);
    if (job.status === "done") {
      finishTransferSoon(900);
      if (job.jobKind === "transfer") {
        await loadTree();
        toast(`${transferActionLabel(job.action)} complete: ${job.targetPath}`);
      } else {
        toast(`Downloaded to ${job.targetPath}`);
      }
      state.currentJobId = "";
      return;
    }
    if (job.status === "canceled") {
      finishTransferSoon(500);
      toast("Transfer canceled");
      state.currentJobId = "";
      return;
    }
    if (job.status === "error") {
      finishTransferSoon(500);
      toast(job.error || "Download failed", true);
      if (job.jobKind === "transfer") {
        window.setTimeout(() => {
          showErrorDialog(job.error || "Transfer failed", `${transferActionLabel(job.action)} Failed`);
        }, 520);
      }
      state.currentJobId = "";
      return;
    }
    state.jobPollTimer = window.setTimeout(pollDownloadJob, 500);
  } catch (error) {
    if (!isAbortError(error)) toast(error.message, true);
  }
}

function updateJobProgress(job) {
  const percent = job.totalBytes ? Math.round((job.completedBytes / job.totalBytes) * 100) : 0;
  const filePart = job.totalFiles ? `${job.completedFiles} / ${job.totalFiles} files` : "Preparing files";
  const bytePart = job.totalBytes ? `${formatBytes(job.completedBytes)} / ${formatBytes(job.totalBytes)}` : "";
  const status = job.status === "canceling" ? "Canceling..." : `${filePart}${bytePart ? `, ${bytePart}` : ""}`;
  updateUploadProgress(percent, status, job.currentFile || job.targetPath || job.destination || "");
}

function downloadUrl(key) {
  return `/api/s3/${encodeURIComponent(state.accountId)}/bucket/${encodeURIComponent(state.bucket)}/download?key=${encodeURIComponent(key)}`;
}

async function fetchBlob(url, signal = null) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return response.blob();
}

async function streamDownloadToFile(url, handle, key) {
  const response = await fetch(url, { signal: state.transferAbortController?.signal });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  const total = Number(response.headers.get("Content-Length") || 0);
  const reader = response.body.getReader();
  const writable = await handle.createWritable();
  let loaded = 0;
  try {
    while (true) {
      throwIfTransferCanceled();
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      loaded += value.byteLength;
      const percent = total ? Math.round((loaded / total) * 100) : 0;
      const message = total ? `${formatBytes(loaded)} / ${formatBytes(total)}` : `${formatBytes(loaded)} downloaded`;
      updateUploadProgress(percent, message, key);
    }
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

async function writeBlobToDirectory(rootHandle, relativePath, blob) {
  const parts = relativePath.split("/").filter(Boolean);
  const filename = parts.pop() || "download";
  let directory = rootHandle;
  for (const part of parts) {
    directory = await directory.getDirectoryHandle(part, { create: true });
  }
  const fileHandle = await directory.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

function fileNameFromKey(key) {
  const parts = key.split("/").filter(Boolean);
  return parts.at(-1) || "download";
}

async function deleteSelected() {
  if (!state.selected) return;
  state.deleteTarget = { kind: "object", key: state.selected.key, type: state.selected.type };
  els.deleteMessage.textContent = `Type delete to remove ${state.selected.key}`;
  els.deleteConfirmInput.value = "";
  els.confirmDeleteBtn.disabled = true;
  els.deleteDialog.showModal();
  els.deleteConfirmInput.focus();
}

function transferActionLabel(action) {
  return action === "move" ? "Move" : "Copy";
}

function formatTransferSource() {
  const account = currentAccount();
  const accountName = account?.name || state.accountId;
  return `${accountName} / ${state.bucket} / ${state.transferTarget?.key || ""}`;
}

function updateTransferTargetPath() {
  els.transferTargetPath.textContent = state.transferBucket
    ? `${state.transferBucket}/${state.transferPrefix || ""}`
    : "Select a bucket";
}

function updateTransferSubmitState() {
  els.confirmTransferBtn.disabled = !(
    state.transferTarget?.key
    && state.transferAccountId
    && state.transferBucket
  );
}

function selectTransferPrefix(prefix, row) {
  state.transferPrefix = prefix || "";
  updateTransferTargetPath();
  document.querySelectorAll(".transfer-tree-node.active").forEach((item) => item.classList.remove("active"));
  row.classList.add("active");
}

function renderTransferAccounts() {
  els.targetAccountSelect.innerHTML = "";
  state.accounts.forEach((account) => {
    const option = document.createElement("option");
    option.value = account.id;
    option.textContent = account.name;
    els.targetAccountSelect.appendChild(option);
  });
  els.targetAccountSelect.value = state.transferAccountId;
}

async function openTransferDialog(action) {
  if (!state.selected?.key) return;
  hideContextMenu();
  state.transferAction = action;
  state.transferTarget = { ...state.selected };
  state.transferAccountId = state.accountId;
  state.transferBucket = state.bucket;
  state.transferPrefix = "";
  state.transferTree = null;
  els.transferDialogTitle.textContent = `${transferActionLabel(action)} To`;
  els.confirmTransferBtn.textContent = transferActionLabel(action);
  els.transferSource.textContent = formatTransferSource();
  renderTransferAccounts();
  updateTransferTargetPath();
  updateTransferSubmitState();
  els.transferTree.innerHTML = '<div class="transfer-empty">Loading folders...</div>';
  els.transferDialog.showModal();
  await loadTransferBuckets();
}

function closeTransferDialog() {
  state.transferTarget = null;
  state.transferTree = null;
  state.transferRequestId += 1;
  els.transferDialog.close();
}

async function loadTransferBuckets() {
  const requestId = ++state.transferRequestId;
  updateTransferTargetPath();
  updateTransferSubmitState();
  if (!state.transferAccountId) {
    els.targetBucketSelect.innerHTML = "";
    els.transferTree.innerHTML = '<div class="transfer-empty">Select a target account.</div>';
    updateTransferSubmitState();
    return;
  }
  try {
    const data = await api(`/api/s3/${encodeURIComponent(state.transferAccountId)}/buckets`);
    if (requestId !== state.transferRequestId || !els.transferDialog.open) return;
    const buckets = data.buckets || [];
    els.targetBucketSelect.innerHTML = "";
    if (!buckets.length) {
      state.transferBucket = "";
      updateTransferTargetPath();
      els.transferTree.innerHTML = '<div class="transfer-empty">This account has no buckets.</div>';
      updateTransferSubmitState();
      return;
    }
    if (!buckets.includes(state.transferBucket)) {
      state.transferBucket = buckets.includes(state.bucket) ? state.bucket : buckets[0];
    }
    buckets.forEach((bucket) => {
      const option = document.createElement("option");
      option.value = bucket;
      option.textContent = bucket;
      els.targetBucketSelect.appendChild(option);
    });
    els.targetBucketSelect.value = state.transferBucket;
    updateTransferSubmitState();
    await loadTransferTree();
  } catch (error) {
    if (requestId !== state.transferRequestId || !els.transferDialog.open) return;
    els.transferTree.innerHTML = `<div class="transfer-empty">Failed to load buckets: ${escapeHtml(error.message)}</div>`;
    updateTransferSubmitState();
    throw error;
  }
}

async function loadTransferTree() {
  const requestId = ++state.transferRequestId;
  state.transferPrefix = "";
  updateTransferTargetPath();
  updateTransferSubmitState();
  if (!state.transferAccountId || !state.transferBucket) {
    els.transferTree.innerHTML = '<div class="transfer-empty">Select a target bucket.</div>';
    return;
  }
  els.transferTree.innerHTML = '<div class="transfer-empty">Loading folders...</div>';
  try {
    const data = await api(`/api/s3/${encodeURIComponent(state.transferAccountId)}/bucket/${encodeURIComponent(state.transferBucket)}/tree`);
    if (requestId !== state.transferRequestId || !els.transferDialog.open) return;
    state.transferTree = data.tree;
    renderTransferTree();
    updateTransferSubmitState();
  } catch (error) {
    if (requestId !== state.transferRequestId || !els.transferDialog.open) return;
    els.transferTree.innerHTML = `<div class="transfer-empty">Failed to load folders: ${escapeHtml(error.message)}</div>`;
    updateTransferSubmitState();
    throw error;
  }
}

function renderTransferTree() {
  els.transferTree.innerHTML = "";
  if (!state.transferBucket) {
    els.transferTree.innerHTML = '<div class="transfer-empty">Select a target bucket.</div>';
    return;
  }
  const rootButton = document.createElement("button");
  rootButton.type = "button";
  rootButton.className = `transfer-tree-node${state.transferPrefix === "" ? " active" : ""}`;
  rootButton.innerHTML = '<span>▾</span><span class="tree-label">Bucket root</span>';
  rootButton.addEventListener("click", () => selectTransferPrefix("", rootButton));
  els.transferTree.appendChild(rootButton);

  const children = document.createElement("div");
  children.className = "transfer-tree-children";
  els.transferTree.appendChild(children);
  renderTransferTreeChildren(state.transferTree, children, true);
}

function renderTransferTreeChildren(node, container, isRoot = false) {
  container.innerHTML = "";
  const folders = (node?.children || []).filter((child) => child.type === "folder");
  if (!folders.length && !node?.hasMore && isRoot) {
    container.innerHTML = '<div class="transfer-empty">No subfolders found. You can still use the bucket root.</div>';
    return;
  }
  folders.forEach((child) => container.appendChild(renderTransferTreeNode(child)));
  if (node?.hasMore) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "show-more";
    button.textContent = "Show more";
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      button.disabled = true;
      button.textContent = "Loading...";
      await loadTransferTreeChildren(node, container, true);
    });
    container.appendChild(button);
  }
}

function renderTransferTreeNode(node, expanded = false) {
  const wrapper = document.createElement("div");
  const row = document.createElement("button");
  row.type = "button";
  row.className = `transfer-tree-node${state.transferPrefix === node.key ? " active" : ""}`;
  row.dataset.key = node.key;

  const icon = document.createElement("span");
  icon.textContent = expanded ? "▾" : "▸";
  const label = document.createElement("span");
  label.className = "tree-label";
  label.textContent = node.name;
  row.append(icon, label);
  wrapper.appendChild(row);

  const children = document.createElement("div");
  children.className = "transfer-tree-children";
  children.hidden = !expanded;
  renderTransferTreeChildren(node, children);
  wrapper.appendChild(children);

  row.addEventListener("click", async () => {
    selectTransferPrefix(node.key, row);
    if (!node.loaded) {
      await loadTransferTreeChildren(node, children);
    }
    children.hidden = !children.hidden;
    icon.textContent = children.hidden ? "▸" : "▾";
  });

  return wrapper;
}

async function loadTransferTreeChildren(node, container, append = false) {
  const token = append ? node.nextToken || "" : "";
  const path = `/api/s3/${encodeURIComponent(state.transferAccountId)}/bucket/${encodeURIComponent(state.transferBucket)}/tree?prefix=${encodeURIComponent(node.key || "")}&token=${encodeURIComponent(token)}`;
  const data = await api(path);
  const incoming = data.tree;
  node.loaded = true;
  node.hasMore = incoming.hasMore;
  node.nextToken = incoming.nextToken;
  node.children = append ? [...(node.children || []), ...(incoming.children || [])] : incoming.children || [];
  renderTransferTreeChildren(node, container);
}

async function submitTransfer(event) {
  event.preventDefault();
  if (!state.transferTarget?.key) return;
  const transferTarget = { ...state.transferTarget };
  const transferAction = state.transferAction;
  const targetAccountId = state.transferAccountId;
  const targetBucket = state.transferBucket;
  const targetPrefix = state.transferPrefix;
  els.confirmTransferBtn.disabled = true;
  try {
    closeTransferDialog();
    showUploadProgress(`${transferActionLabel(transferAction)}ing ${transferTarget.type === "folder" ? "Folder" : "File"}`);
    const data = await api(`/api/s3/${encodeURIComponent(state.accountId)}/bucket/${encodeURIComponent(state.bucket)}/transfer`, {
      method: "POST",
      signal: state.transferAbortController?.signal,
      body: JSON.stringify({
        key: transferTarget.key,
        type: transferTarget.type,
        action: transferAction,
        targetAccountId,
        targetBucket,
        targetPrefix,
      }),
    });
    state.currentJobId = data.job.id;
    updateJobProgress(data.job);
    pollDownloadJob();
  } catch (error) {
    finishTransferSoon(0);
    showErrorDialog(error.message, `${transferActionLabel(transferAction)} Failed`);
    throw error;
  } finally {
    if (els.transferDialog.open) {
      updateTransferSubmitState();
    }
  }
}

async function runContextMenuAction(action) {
  hideContextMenu();
  if (!state.selected?.key) return;
  if (action === "download") {
    await downloadSelected();
    return;
  }
  if (action === "delete") {
    await deleteSelected();
    return;
  }
  if (action === "copy" || action === "move") {
    await openTransferDialog(action);
  }
}

async function confirmDeleteSelected(event) {
  event.preventDefault();
  if (els.deleteConfirmInput.value !== "delete" || !state.deleteTarget) return;
  if (state.deleteTarget.kind === "bucket") {
    await api(`/api/s3/${encodeURIComponent(state.accountId)}/bucket/${encodeURIComponent(state.bucket)}/bucket`, {
      method: "DELETE",
      body: JSON.stringify({ confirm: "delete" }),
    });
    const deletedBucket = state.bucket;
    state.bucket = "";
    state.selected = null;
    state.deleteTarget = null;
    els.deleteDialog.close();
    resetViewer();
    await loadBuckets();
    toast(`Bucket deleted: ${deletedBucket}`);
    return;
  }
  await api(`/api/s3/${encodeURIComponent(state.accountId)}/bucket/${encodeURIComponent(state.bucket)}/delete`, {
    method: "POST",
    body: JSON.stringify({ key: state.deleteTarget.key, type: state.deleteTarget.type, confirm: "delete" }),
  });
  state.deleteTarget = null;
  els.deleteDialog.close();
  toast("Deleted");
  await loadTree();
}

function closeDeleteDialog() {
  state.deleteTarget = null;
  els.deleteDialog.close();
}

async function createBucket() {
  if (!state.accountId) return toast("Select an account first", true);
  const name = window.prompt("New bucket name\nUse lowercase letters, numbers, dots, or hyphens. Bucket names must be globally unique across AWS S3.");
  if (!name) return;
  const trimmedName = name.trim();
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(trimmedName) || trimmedName.length < 3 || trimmedName.length > 63) {
    toast("Invalid bucket name. Use 3-63 characters with lowercase letters, numbers, dots, or hyphens.", true);
    return;
  }
  try {
    await api(`/api/s3/${encodeURIComponent(state.accountId)}/buckets`, {
      method: "POST",
      body: JSON.stringify({ name: trimmedName }),
    });
    toast("Bucket created");
    await loadBuckets();
    await selectBucket(trimmedName);
  } catch (error) {
    const message = error?.message || "Bucket creation failed";
    toast(message, true);
    window.alert(`Bucket creation failed.\n\n${message}`);
  }
}

async function deleteBucket() {
  if (!state.accountId || !state.bucket) return;
  state.deleteTarget = { kind: "bucket", bucket: state.bucket };
  els.deleteMessage.textContent = `Type delete to remove bucket ${state.bucket} and all listed objects under it`;
  els.deleteConfirmInput.value = "";
  els.confirmDeleteBtn.disabled = true;
  els.deleteDialog.showModal();
  els.deleteConfirmInput.focus();
}

async function createFolder() {
  if (!state.bucket) return toast("Select a bucket first", true);
  const parent = state.selected?.type === "folder" ? state.selected.key : parentPrefix(state.selected?.key || "");
  const name = window.prompt("New folder name");
  if (!name) return;
  await api(`/api/s3/${encodeURIComponent(state.accountId)}/bucket/${encodeURIComponent(state.bucket)}/folder`, {
    method: "POST",
    body: JSON.stringify({ parent, name }),
  });
  toast("Folder created");
  await loadTree();
}

async function collectDroppedFiles(dataTransfer) {
  const items = [...(dataTransfer.items || [])];
  const entries = items.map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) {
    return [...dataTransfer.files].map((file) => ({ file, path: file.name }));
  }
  const results = [];
  await Promise.all(entries.map((entry) => walkEntry(entry, "", results)));
  return results;
}

function walkEntry(entry, parentPath, results) {
  return new Promise((resolve, reject) => {
    const path = parentPath ? `${parentPath}/${entry.name}` : entry.name;
    if (entry.isFile) {
      entry.file(
        (file) => {
          results.push({ file, path });
          resolve();
        },
        (error) => reject(error),
      );
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      const pending = [];
      const readBatch = () => {
        reader.readEntries(async (entries) => {
          if (!entries.length) {
            Promise.all(pending).then(resolve).catch(reject);
            return;
          }
          pending.push(...entries.map((child) => walkEntry(child, path, results)));
          readBatch();
        }, reject);
      };
      readBatch();
      return;
    }
    resolve();
  });
}

async function uploadDropped(event) {
  event.preventDefault();
  els.dropZone.classList.remove("dragging");
  if (!state.bucket) return toast("Select a bucket first", true);
  const prefix = state.selected?.type === "folder" ? state.selected.key : parentPrefix(state.selected?.key || "");
  const files = await collectDroppedFiles(event.dataTransfer);
  if (!files.length) return;
  await uploadFilesWithProgress(files, prefix);
  toast("Upload complete");
  await loadTree();
}

async function uploadFilesWithProgress(files, prefix) {
  const isFolderUpload = files.length > 1 || files.some(({ path }) => path.includes("/"));
  showUploadProgress(isFolderUpload ? "Uploading Folder" : "Uploading File");
  if (isFolderUpload) {
    let completed = 0;
    await runWithConcurrency(files, 5, async (item) => {
      throwIfTransferCanceled();
      updateUploadProgress(Math.round((completed / files.length) * 100), `${completed} / ${files.length} files uploaded`, item.path);
      await uploadOneFile(item, prefix);
      completed += 1;
      updateUploadProgress(Math.round((completed / files.length) * 100), `${completed} / ${files.length} files uploaded`, item.path);
    });
  } else {
    const item = files[0];
    await uploadOneFile(item, prefix, (loaded, total) => {
      const percent = total ? Math.round((loaded / total) * 100) : 0;
      updateUploadProgress(percent, `${formatBytes(loaded)} / ${formatBytes(total || item.file.size)}`, item.path);
    }, () => {
      updateUploadProgress(100, "Uploaded locally; sending to S3...", item.path);
    });
  }
  updateUploadProgress(100, isFolderUpload ? `${files.length} / ${files.length} files uploaded` : "Upload complete", "");
  finishTransferSoon();
}

function uploadOneFile({ file, path }, prefix, onProgress = null, onLocalComplete = null) {
  return new Promise((resolve, reject) => {
    if (state.transferAbortController?.signal.aborted) {
      reject(new DOMException("Transfer canceled", "AbortError"));
      return;
    }
    const form = new FormData();
    form.append("files", file, path);
    const xhr = new XMLHttpRequest();
    state.activeXhrs.add(xhr);
    const url = `/api/s3/${encodeURIComponent(state.accountId)}/bucket/${encodeURIComponent(state.bucket)}/upload?prefix=${encodeURIComponent(prefix)}`;
    xhr.open("POST", url);
    const abortUpload = () => xhr.abort();
    state.transferAbortController?.signal.addEventListener("abort", abortUpload, { once: true });
    xhr.upload.onprogress = (event) => {
      if (onProgress && event.lengthComputable) {
        onProgress(event.loaded, event.total);
      }
    };
    xhr.upload.onload = () => {
      if (onLocalComplete) onLocalComplete();
    };
    xhr.onload = () => {
      state.activeXhrs.delete(xhr);
      state.transferAbortController?.signal.removeEventListener("abort", abortUpload);
      const data = JSON.parse(xhr.responseText || "{}");
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
      } else {
        reject(new Error(data.error || `HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => {
      state.activeXhrs.delete(xhr);
      state.transferAbortController?.signal.removeEventListener("abort", abortUpload);
      reject(new Error("Upload failed"));
    };
    xhr.onabort = () => {
      state.activeXhrs.delete(xhr);
      reject(new DOMException("Transfer canceled", "AbortError"));
    };
    xhr.send(form);
  });
}

function showUploadProgress(title) {
  state.transferAbortController = new AbortController();
  state.transferClosing = false;
  state.activeXhrs.clear();
  els.cancelTransferBtn.hidden = false;
  els.cancelTransferBtn.textContent = title.toLowerCase().includes("upload") ? "Cancel Upload" : "Cancel Download";
  els.uploadTitle.textContent = title;
  updateUploadProgress(0, "Preparing upload...", "");
  els.uploadDialog.showModal();
}

async function cancelTransfer() {
  if (!state.transferAbortController) return;
  const label = els.cancelTransferBtn.textContent || "Cancel transfer";
  if (!window.confirm(`${label}?`)) return;
  state.transferClosing = true;
  if (state.currentJobId) {
    await api(`/api/jobs/${encodeURIComponent(state.currentJobId)}/cancel`, { method: "POST" }).catch(() => {});
  }
  state.transferAbortController.abort();
  for (const xhr of state.activeXhrs) {
    xhr.abort();
  }
  state.activeXhrs.clear();
  updateUploadProgress(0, "Canceling...", "");
  if (!state.currentJobId) {
    finishTransferSoon(450);
  }
}

function finishTransferSoon(delay = 500) {
  if (state.transferClosing && !els.uploadDialog.open) return;
  state.transferClosing = true;
  els.cancelTransferBtn.hidden = true;
  window.setTimeout(() => {
    els.uploadDialog.close();
    state.transferAbortController = null;
    state.activeXhrs.clear();
    state.currentJobId = "";
    if (state.jobPollTimer) {
      window.clearTimeout(state.jobPollTimer);
      state.jobPollTimer = null;
    }
    state.transferClosing = false;
  }, delay);
}

function throwIfTransferCanceled() {
  if (state.transferAbortController?.signal.aborted) {
    throw new DOMException("Transfer canceled", "AbortError");
  }
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function handleTransferError(error) {
  if (isAbortError(error)) {
    if (!state.transferClosing) {
      updateUploadProgress(0, "Canceled", "");
      finishTransferSoon(350);
      toast("Transfer canceled");
    }
    return;
  }
  toast(error.message, true);
  showErrorDialog(error.message, "Transfer Failed");
}

function updateUploadProgress(percent, message, detail) {
  els.uploadProgressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  els.uploadMessage.textContent = message;
  els.uploadDetail.textContent = detail || "";
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function parentPrefix(key) {
  if (!key || !key.includes("/")) return "";
  return key.slice(0, key.lastIndexOf("/") + 1);
}

function resetViewer() {
  state.selected = null;
  state.editing = false;
  state.currentContent = "";
  els.selectedType.textContent = "Nothing selected";
  els.selectedName.textContent = "Select a file or folder";
  els.preview.textContent = "Preview and edit text files such as txt, xml, json, yaml, config, properties, sh, env, tpl, script, py, c, cpp, and java. Preview images such as png, jpg, jpeg, bmp, and gif.";
  els.preview.hidden = false;
  els.editorWrap.hidden = true;
  els.saveBtn.hidden = true;
  els.editBtn.disabled = true;
  els.downloadBtn.disabled = true;
  els.deleteBtn.disabled = true;
}

function renderHighlighted(target, content, key) {
  const language = languageForKey(key);
  target.innerHTML = highlightCode(content, language);
}

function languageForKey(key = "") {
  const name = key.toLowerCase();
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  if (extension === ".json") return "json";
  if (extension === ".yaml" || extension === ".yml") return "yaml";
  if (extension === ".py") return "python";
  if ([".c", ".h"].includes(extension)) return "c";
  if ([".cpp", ".cc", ".cxx", ".hpp"].includes(extension)) return "cpp";
  if (extension === ".java") return "java";
  return "text";
}

function highlightCode(content, language) {
  if (!content) return "";
  if (language === "json") return highlightJson(content);
  if (language === "yaml") return highlightYaml(content);
  if (["python", "c", "cpp", "java"].includes(language)) return highlightProgramming(content, language);
  return escapeHtml(content);
}

function highlightJson(content) {
  return highlightTokens(content, /("(?:\\.|[^"\\])*")(\s*:)?|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, (token, match) => {
    if (match[1] && match[2]) return `<span class="tok-key">${escapeHtml(match[1])}</span>${escapeHtml(match[2])}`;
    if (match[1]) return `<span class="tok-string">${escapeHtml(token)}</span>`;
    if (/^(true|false|null)$/.test(token)) return `<span class="tok-boolean">${token}</span>`;
    return `<span class="tok-number">${token}</span>`;
  });
}

function highlightYaml(content) {
  return highlightTokens(content, /(^[ \t-]*[A-Za-z0-9_.-]+)(\s*:)|(#.*$)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\b(?:true|false|null|yes|no|on|off)\b|-?\b\d+(?:\.\d+)?\b/gm, (token, match) => {
    if (match[1] && match[2]) return `<span class="tok-key">${escapeHtml(match[1])}</span>${escapeHtml(match[2])}`;
    if (match[3]) return `<span class="tok-comment">${escapeHtml(token)}</span>`;
    if (match[4]) return `<span class="tok-string">${escapeHtml(token)}</span>`;
    if (/^(true|false|null|yes|no|on|off)$/.test(token)) return `<span class="tok-boolean">${token}</span>`;
    return `<span class="tok-number">${token}</span>`;
  });
}

function highlightProgramming(content, language) {
  const keywords = {
    python: "and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield",
    c: "auto|break|case|char|const|continue|default|do|double|else|enum|extern|float|for|goto|if|inline|int|long|register|restrict|return|short|signed|sizeof|static|struct|switch|typedef|union|unsigned|void|volatile|while",
    cpp: "alignas|alignof|and|asm|auto|bool|break|case|catch|char|class|const|constexpr|continue|decltype|default|delete|do|double|else|enum|explicit|export|extern|false|float|for|friend|if|inline|int|long|namespace|new|nullptr|operator|private|protected|public|return|short|signed|sizeof|static|struct|switch|template|this|throw|true|try|typedef|typename|union|unsigned|using|virtual|void|volatile|while",
    java: "abstract|assert|boolean|break|byte|case|catch|char|class|const|continue|default|do|double|else|enum|extends|false|final|finally|float|for|if|implements|import|instanceof|int|interface|long|native|new|null|package|private|protected|public|return|short|static|strictfp|super|switch|synchronized|this|throw|throws|transient|true|try|void|volatile|while",
  };
  const comments = language === "python" ? "#.*$" : "\\/\\/.*$|\\/\\*[\\s\\S]*?\\*\\/";
  const strings = language === "python"
    ? "\"\"\"[\\s\\S]*?\"\"\"|'''[\\s\\S]*?'''|\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'"
    : "\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'";
  const pattern = new RegExp(`(${comments})|(${strings})|\\b(${keywords[language]})\\b|\\b(\\d+(?:\\.\\d+)?)\\b`, "gm");
  return highlightTokens(content, pattern, (token, match) => {
    if (match[1]) return `<span class="tok-comment">${escapeHtml(token)}</span>`;
    if (match[2]) return `<span class="tok-string">${escapeHtml(token)}</span>`;
    if (match[3]) return `<span class="tok-keyword">${escapeHtml(token)}</span>`;
    return `<span class="tok-number">${escapeHtml(token)}</span>`;
  });
}

function highlightTokens(content, pattern, render) {
  let result = "";
  let index = 0;
  for (const match of content.matchAll(pattern)) {
    result += escapeHtml(content.slice(index, match.index));
    result += render(match[0], match);
    index = match.index + match[0].length;
  }
  result += escapeHtml(content.slice(index));
  return result;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char];
  });
}

function bindEvents() {
  document.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (!event.target.closest(".tree-node")) {
      hideContextMenu();
    }
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#contextMenu")) {
      hideContextMenu();
    }
  });
  window.addEventListener("resize", hideContextMenu);
  $("refreshAccounts").addEventListener("click", () => loadAccounts().catch((error) => toast(error.message, true)));
  $("newAccountBtn").addEventListener("click", () => openAccountDialog(null));
  $("editAccountBtn").addEventListener("click", () => openAccountDialog(currentAccount()));
  $("deleteSelectedAccountBtn").addEventListener("click", () => deleteAccount().catch((error) => toast(error.message, true)));
  $("closeAccountDialog").addEventListener("click", closeAccountDialog);
  $("cancelAccountBtn").addEventListener("click", closeAccountDialog);
  els.accountSelect.addEventListener("change", () => selectAccount(els.accountSelect.value));
  els.accountForm.addEventListener("submit", (event) => saveAccount(event).catch((error) => toast(error.message, true)));
  els.deleteAccountBtn.addEventListener("click", () => deleteAccount().catch((error) => toast(error.message, true)));
  $("closeDeleteDialog").addEventListener("click", closeDeleteDialog);
  $("cancelDeleteBtn").addEventListener("click", closeDeleteDialog);
  $("closeLocalDownloadDialog").addEventListener("click", closeLocalDownloadDialog);
  $("cancelLocalDownloadBtn").addEventListener("click", closeLocalDownloadDialog);
  els.localDownloadForm.addEventListener("submit", (event) => submitLocalDownload(event).catch((error) => toast(error.message, true)));
  $("closeTransferDialog").addEventListener("click", closeTransferDialog);
  $("cancelTransferDialogBtn").addEventListener("click", closeTransferDialog);
  els.transferForm.addEventListener("submit", (event) => submitTransfer(event).catch(() => {}));
  $("closeErrorDialog").addEventListener("click", closeErrorDialog);
  $("confirmErrorDialogBtn").addEventListener("click", closeErrorDialog);
  els.targetAccountSelect.addEventListener("change", () => {
    state.transferAccountId = els.targetAccountSelect.value;
    loadTransferBuckets().catch((error) => toast(error.message, true));
  });
  els.targetBucketSelect.addEventListener("change", () => {
    state.transferBucket = els.targetBucketSelect.value;
    loadTransferTree().catch((error) => toast(error.message, true));
  });
  $("contextDownloadBtn").addEventListener("click", () => runContextMenuAction("download").catch(handleTransferError));
  $("contextMoveBtn").addEventListener("click", () => runContextMenuAction("move").catch((error) => toast(error.message, true)));
  $("contextCopyBtn").addEventListener("click", () => runContextMenuAction("copy").catch((error) => toast(error.message, true)));
  $("contextDeleteBtn").addEventListener("click", () => runContextMenuAction("delete").catch((error) => toast(error.message, true)));
  els.deleteConfirmInput.addEventListener("input", () => {
    els.confirmDeleteBtn.disabled = els.deleteConfirmInput.value !== "delete";
  });
  els.deleteForm.addEventListener("submit", (event) => confirmDeleteSelected(event).catch((error) => toast(error.message, true)));
  els.editor.addEventListener("input", () => {
    renderHighlighted(els.editorHighlight, els.editor.value, state.selected?.key || "");
  });
  els.editor.addEventListener("scroll", () => {
    els.editorHighlight.scrollTop = els.editor.scrollTop;
    els.editorHighlight.scrollLeft = els.editor.scrollLeft;
  });
  $("refreshBuckets").addEventListener("click", () => loadBuckets());
  els.newBucketBtn.addEventListener("click", () => createBucket().catch((error) => toast(error.message, true)));
  els.deleteBucketBtn.addEventListener("click", () => deleteBucket().catch((error) => toast(error.message, true)));
  $("refreshTree").addEventListener("click", () => loadTree());
  $("newFolderBtn").addEventListener("click", () => createFolder().catch((error) => toast(error.message, true)));
  els.editBtn.addEventListener("click", beginEdit);
  els.saveBtn.addEventListener("click", () => saveFile().catch((error) => toast(error.message, true)));
  els.cancelTransferBtn.addEventListener("click", () => cancelTransfer().catch((error) => toast(error.message, true)));
  els.downloadBtn.addEventListener("click", () => downloadSelected().catch(handleTransferError));
  els.deleteBtn.addEventListener("click", () => deleteSelected().catch((error) => toast(error.message, true)));
  els.dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    els.dropZone.classList.add("dragging");
  });
  els.dropZone.addEventListener("dragleave", () => els.dropZone.classList.remove("dragging"));
  els.dropZone.addEventListener("drop", (event) => uploadDropped(event).catch(handleTransferError));
}

bindEvents();
loadAccounts().catch((error) => toast(error.message, true));
