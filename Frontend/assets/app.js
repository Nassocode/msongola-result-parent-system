const loginForm = document.getElementById("loginForm");
const loginSection = document.getElementById("loginSection");
const loginMessage = document.getElementById("loginMessage");
const loginButton = document.getElementById("loginButton");
const appShell = document.getElementById("appShell");
const appMessage = document.getElementById("appMessage");
const summaryTableBody = document.getElementById("summaryTableBody");
const batchTableBody = document.getElementById("batchTableBody");
const integrationBatchTableBody = document.getElementById("integrationBatchTableBody");
const integrationBatchSearch = document.getElementById("integrationBatchSearch");
const integrationBatchStatusFilter = document.getElementById("integrationBatchStatusFilter");
const refreshIntegrationBatchesButton = document.getElementById("refreshIntegrationBatchesButton");
const outboxTableBody = document.getElementById("outboxTableBody");
const outboxStatusFilter = document.getElementById("outboxStatusFilter");
const refreshOutboxButton = document.getElementById("refreshOutboxButton");
const studentList = document.getElementById("studentList");
const studentSearch = document.getElementById("studentSearch");
const studentClassFilter = document.getElementById("studentClassFilter");
const studentContactFilter = document.getElementById("studentContactFilter");
const studentRecordModal = document.getElementById("studentRecordModal");
const studentRecordForm = document.getElementById("studentRecordForm");
const studentGuardianFields = document.getElementById("studentGuardianFields");
const studentCsvFileInput = document.getElementById("studentCsvFileInput");
const studentCsvPreviewPanel = document.getElementById("studentCsvPreviewPanel");
const studentCsvPreviewBody = document.getElementById("studentCsvPreviewBody");
const studentCsvErrorList = document.getElementById("studentCsvErrorList");
const confirmStudentCsvImportButton = document.getElementById("confirmStudentCsvImportButton");
const resultsReportTableBody = document.getElementById("resultsReportTableBody");
const staffAccountForm = document.getElementById("staffAccountForm");
const staffAccountModal = document.getElementById("staffAccountModal");
const staffAccountFormPanel = document.getElementById("staffAccountFormPanel");
const staffPasswordForm = document.getElementById("staffPasswordForm");
const staffPasswordModal = document.getElementById("staffPasswordModal");
const staffAccountTableBody = document.getElementById("staffAccountTableBody");
const staffAccountSearch = document.getElementById("staffAccountSearch");
const staffRoleFilter = document.getElementById("staffRoleFilter");
const refreshStaffAccountsButton = document.getElementById("refreshStaffAccountsButton");
const appBasePath = new URL(".", document.baseURI).pathname.replace(/\/$/, "");
const pageTitles = {
  overviewView: "Overview",
  studentsView: "Learners & results",
  reportsView: "Results reports",
  smsView: "Parent SMS outbox",
  integrationView: "Results integration",
  staffAccountsView: "Staff accounts",
  profileView: "My profile",
};

let authToken = sessionStorage.getItem("msongolaAdminToken") || "";
let students = [];
let studentsLoaded = false;
let academicReportRows = [];
let reportLoaded = false;
let integrationBatches = [];
let staffAccounts = [];
let currentUser = null;
let selectedStudentId = "";
let selectedStudentRecord = null;
let editingStudentId = "";
let studentCsvRecords = [];
let studentCsvErrors = [];
let editingStaffAccountId = "";
let staffPasswordTargetId = "";
let outboxRequestId = 0;
let integrationBatchesRequestId = 0;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

async function requestJson(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  let response;
  try {
    const requestUrl = new URL(url, window.location.href);
    if (requestUrl.origin === window.location.origin && requestUrl.pathname.startsWith("/api/")) {
      requestUrl.pathname = `${appBasePath}${requestUrl.pathname}`;
    }
    response = await fetch(requestUrl, { ...options, headers });
  } catch (error) {
    throw new Error("Unable to reach the server. Check that the backend is running.");
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    payload = {};
  }

  if (!response.ok) {
    if (response.status === 401 && authToken) {
      signOut("Your session has expired. Please sign in again.");
    }
    throw new Error(payload.message || `Request failed (${response.status}).`);
  }

  return payload;
}

function showAppMessage(message, isError = false) {
  appMessage.textContent = message;
  appMessage.classList.toggle("error", isError);
  appMessage.classList.remove("hidden");
  window.clearTimeout(showAppMessage.timeoutId);
  showAppMessage.timeoutId = window.setTimeout(() => appMessage.classList.add("hidden"), 5000);
}

function setLoginMessage(message, isError = true) {
  loginMessage.textContent = message;
  loginMessage.style.color = isError ? "#b42318" : "#176c4e";
}

function getInitials(name) {
  return String(name || "A")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join("")
    .toUpperCase();
}

function setView(viewId) {
  const isAdmin = String(currentUser?.role || "").toUpperCase() === "ADMIN";
  if ((viewId === "studentsView" || viewId === "reportsView") && isAdmin) {
    showAppMessage("Learner results and academic reports are available to the Academic Master only.", true);
    return;
  }
  if (viewId === "staffAccountsView" && !isAdmin) {
    showAppMessage("Only the system administrator can manage staff accounts.", true);
    return;
  }
  if (viewId === "smsView" && !isAdmin) {
    showAppMessage("SMS delivery operations are available to the system administrator only.", true);
    return;
  }

  document.querySelectorAll(".content-view").forEach((view) => {
    view.classList.toggle("hidden", view.id !== viewId);
  });
  document.querySelectorAll(".nav-link").forEach((link) => {
    link.classList.toggle("active", link.dataset.view === viewId);
  });
  document.getElementById("pageTitle").textContent = pageTitles[viewId] || "Overview";

  if (viewId === "studentsView" && !studentsLoaded) {
    loadStudents();
  } else if (viewId === "reportsView" && !reportLoaded) {
    loadResultsReport();
  } else if (viewId === "smsView") {
    loadOutbox();
  } else if (viewId === "integrationView") {
    loadIntegrationBatches();
    if (isAdmin) loadIntegrationReadiness();
  } else if (viewId === "staffAccountsView") {
    loadStaffAccounts();
  } else if (viewId === "profileView") {
    renderStaffProfile();
  }
}

function renderStaffProfile() {
  if (!currentUser) return;

  const name = String(currentUser.name || "Staff member");
  const email = String(currentUser.email || "Not available");
  const role = String(currentUser.role || "").toUpperCase();
  const isAdmin = role === "ADMIN";
  const roleLabel = isAdmin ? "Administrator" : "Academic Master";
  const workspaceLabel = isAdmin ? "Administrator workspace" : "Academic workspace";
  const accessItems = isAdmin
    ? [
      ["System overview", "Monitor service readiness, staff accounts, and recent activity."],
      ["Parent SMS operations", "Review queued messages, delivery statuses, and failed SMS."],
      ["Results integration", "Review imported batches and integration readiness."],
      ["Staff account administration", "Create and manage staff accounts and their roles."],
    ]
    : [
      ["Academic overview", "Review learner, result, and subject performance summaries."],
      ["Learners and results", "Register learners, maintain guardian contacts, and review academic records."],
      ["Results reports", "Filter, export, and print academic result reports."],
      ["Results import history", "Review approved result batches and aggregate parent SMS status totals."],
    ];

  document.getElementById("profileAvatar").textContent = getInitials(name);
  document.getElementById("profileName").textContent = name;
  document.getElementById("profileRoleLabel").textContent = roleLabel;
  document.getElementById("profileDetailName").textContent = name;
  document.getElementById("profileDetailEmail").textContent = email;
  document.getElementById("profileDetailId").textContent = currentUser.id ? `#${currentUser.id}` : "Not available";
  document.getElementById("profileDetailWorkspace").textContent = workspaceLabel;
  document.getElementById("profileAccessDescription").textContent =
    `Your ${roleLabel} role determines which school records and tools you can access.`;
  document.getElementById("profileAccessList").innerHTML = accessItems.map(([title, description]) => `
    <div class="profile-access-item">
      <span class="profile-access-check" aria-hidden="true">✓</span>
      <div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(description)}</p></div>
    </div>
  `).join("");
}

function showApplication(user) {
  currentUser = user;
  const name = user.name || "Administrator";
  const isAdmin = String(user.role || "").toUpperCase() === "ADMIN";
  const roleDashboard = isAdmin ? "admin" : "academic_master";
  document.getElementById("staffName").textContent = name;
  document.getElementById("staffRole").textContent = String(user.role || "Staff").replaceAll("_", " ");
  document.getElementById("staffInitials").textContent = getInitials(name);
  document.getElementById("welcomeName").textContent = name.split(/\s+/)[0];
  document.getElementById("workspaceLabel").textContent = isAdmin ? "Administrator workspace" : "Academic workspace";
  document.getElementById("workspaceEyebrow").textContent = isAdmin ? "SYSTEM ADMINISTRATION" : "ACADEMIC OFFICE";
  document.getElementById("welcomeDescription").textContent = isAdmin
    ? "Monitor staff access, integrations, and parent message delivery."
    : "Review learner results, subject performance, and approved result imports.";
  document.getElementById("integrationViewEyebrow").textContent =
    isAdmin ? "SYSTEM-TO-SYSTEM" : "ACADEMIC WORKFLOW";
  document.getElementById("integrationViewTitle").textContent =
    isAdmin ? "Approved results integration" : "Results import history";
  document.getElementById("integrationViewDescription").textContent = isAdmin
    ? "The school results system submits finalized batches. No parent accounts are created."
    : "Review approved result batches and parent SMS progress from the school results system.";
  const primaryAction = document.getElementById("dashboardPrimaryAction");
  primaryAction.dataset.openView = isAdmin ? "staffAccountsView" : "studentsView";
  primaryAction.innerHTML = isAdmin
    ? 'Manage staff accounts <span aria-hidden="true">→</span>'
    : 'Review results <span aria-hidden="true">→</span>';
  document.querySelectorAll("[data-admin-only]").forEach((element) => {
    element.classList.toggle("hidden", !isAdmin);
  });
  document.querySelectorAll("[data-academic-only]").forEach((element) => {
    element.classList.toggle("hidden", isAdmin);
  });
  document.querySelectorAll("[data-role-dashboard]").forEach((element) => {
    element.classList.toggle("hidden", element.dataset.roleDashboard !== roleDashboard);
  });
  document.getElementById("currentDate").textContent = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date());

  loginSection.classList.add("hidden");
  appShell.classList.remove("hidden");
  setView("overviewView");
}

function signOut(message = "") {
  authToken = "";
  currentUser = null;
  students = [];
  studentsLoaded = false;
  academicReportRows = [];
  reportLoaded = false;
  staffAccounts = [];
  selectedStudentId = "";
  editingStaffAccountId = "";
  sessionStorage.removeItem("msongolaAdminToken");
  appShell.classList.add("hidden");
  loginSection.classList.remove("hidden");
  document.getElementById("password").value = "";
  setLoginMessage(message, Boolean(message));
}

function renderSummary(summary) {
  if (!summary.length) {
    summaryTableBody.innerHTML = '<tr><td colspan="5" class="empty-state">No approved results have been imported yet.</td></tr>';
    return;
  }

  summaryTableBody.innerHTML = summary.map((row) => `
    <tr>
      <td>${escapeHtml(row.subject)}</td>
      <td>${Number(row.averageScore || 0).toFixed(1)}%</td>
      <td>${escapeHtml(row.highestScore ?? "-")}</td>
      <td>${escapeHtml(row.lowestScore ?? "-")}</td>
      <td>${escapeHtml(row.entries ?? 0)}</td>
    </tr>
  `).join("");
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? escapeHtml(value)
    : escapeHtml(new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date));
}

function renderBatches(batches) {
  const isAdmin = String(currentUser?.role || "").toUpperCase() === "ADMIN";
  if (!batches.length) {
    batchTableBody.innerHTML = '<tr><td colspan="6" class="empty-state">No results batches received yet.</td></tr>';
    return;
  }

  batchTableBody.innerHTML = batches.map((batch) => `
    <tr>
      <td>${escapeHtml(batch.examName)}<small class="table-subtext">${escapeHtml(batch.term)} ${escapeHtml(batch.year)}</small></td>
      <td>${escapeHtml(batch.sourceBatchId)}</td>
      <td>${formatDate(batch.receivedAt)}</td>
      <td>${escapeHtml(batch.importedRecords)} / ${escapeHtml(batch.receivedRecords)}</td>
      <td data-admin-only class="${isAdmin ? "" : "hidden"}">${escapeHtml(batch.queuedMessages)}</td>
      <td><span class="table-status status-${escapeHtml(String(batch.status).toLowerCase())}">${escapeHtml(batch.status)}</span></td>
    </tr>
  `).join("");
}

function renderBatchSmsStatus(batch) {
  const statuses = [
    ["Queued", "pendingSmsCount", "pending"],
    ["Sending", "processingSmsCount", "processing"],
    ["Accepted", "sentSmsCount", "sent"],
    ["Delivered", "deliveredSmsCount", "delivered"],
    ["Failed", "failedSmsCount", "failed"],
  ].map(([label, property, className]) => ({
    label,
    className,
    count: Math.max(0, Math.trunc(Number(batch[property]) || 0)),
  }));

  if (statuses.every((status) => status.count === 0)) {
    return '<span class="batch-sms-empty">No SMS queued</span>';
  }

  const accessibleSummary = statuses.map(({ label, count }) => `${label}: ${count}`).join(", ");
  return `<div class="batch-sms-status" aria-label="${escapeHtml(accessibleSummary)}">${statuses.map(({ label, className, count }) => `
    <span class="batch-sms-count status-${className}">${label} ${count}</span>
  `).join("")}</div>`;
}

function renderIntegrationBatches() {
  const isAdmin = String(currentUser?.role || "").toUpperCase() === "ADMIN";
  const query = integrationBatchSearch.value.trim().toLowerCase();
  const selectedStatus = integrationBatchStatusFilter.value;
  const filtered = integrationBatches.filter((batch) => {
    const searchable = [
      batch.examName,
      batch.sourceBatchId,
      batch.sourceSystem,
      batch.term,
      batch.year,
    ].join(" ").toLowerCase();
    return searchable.includes(query) && (!selectedStatus || batch.status === selectedStatus);
  });

  document.getElementById("integrationBatchCount").textContent =
    `${filtered.length} of ${integrationBatches.length} ${integrationBatches.length === 1 ? "batch" : "batches"}`;

  if (!filtered.length) {
    const message = integrationBatches.length
      ? "No imports match your search and status filters."
      : "No results batches received yet.";
    integrationBatchTableBody.innerHTML = `<tr><td colspan="10" class="empty-state">${message}</td></tr>`;
    return;
  }

  integrationBatchTableBody.innerHTML = filtered.map((batch) => `
    <tr>
      <td>${escapeHtml(batch.examName)}<small class="table-subtext">${escapeHtml(batch.term)} ${escapeHtml(batch.year)}</small></td>
      <td>${escapeHtml(batch.sourceBatchId)}</td>
      <td>${escapeHtml(batch.sourceSystem)}</td>
      <td>${formatDate(batch.receivedAt)}${batch.completedAt ? `<small class="table-subtext">Finished ${formatDate(batch.completedAt)}</small>` : ""}</td>
      <td>${escapeHtml(batch.importedRecords)} / ${escapeHtml(batch.receivedRecords)}</td>
      <td>${escapeHtml(batch.duplicateRecords)}</td>
      <td>${renderBatchSmsStatus(batch)}</td>
      <td>${escapeHtml(batch.missingContacts)}</td>
      <td><span class="table-status status-${escapeHtml(String(batch.status).toLowerCase())}">${escapeHtml(batch.status)}</span></td>
      <td data-admin-only class="${isAdmin ? "" : "hidden"}">${isAdmin && batch.status === "COMPLETED"
        ? `<button class="button button-secondary button-compact" type="button" data-queue-batch-sms="${escapeHtml(batch.id)}">Queue for contacts</button>`
        : "—"}</td>
    </tr>
  `).join("");
}

function renderStudentList() {
  const query = studentSearch.value.trim().toLowerCase();
  const selectedClass = studentClassFilter.value;
  const classNames = [...new Set(students.map((student) => student.className).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  const previousClass = selectedClass;
  studentClassFilter.replaceChildren(new Option("All classes", ""));
  classNames.forEach((className) => studentClassFilter.add(new Option(className, className)));
  studentClassFilter.value = classNames.includes(previousClass) ? previousClass : "";

  const filtered = getFilteredStudents();
  document.getElementById("exportStudentCsvButton").disabled = !filtered.length;
  document.getElementById("learnerCountChip").textContent =
    studentContactFilter.value === "missing"
      ? `${filtered.length} of ${students.length} missing contacts`
      : `${filtered.length} of ${students.length} learners`;

  if (selectedStudentId && !filtered.some((student) => String(student.id) === selectedStudentId)) {
    selectedStudentId = "";
    selectedStudentRecord = null;
    document.getElementById("selectedStudentName").textContent = "Select a learner";
    document.getElementById("selectedStudentMeta").textContent =
      "Choose a learner from the filtered list to see their result records.";
    document.getElementById("editStudentButton").disabled = true;
    document.getElementById("selectedStudentGuardians").innerHTML =
      '<p class="empty-state">Select a learner to view registered contacts.</p>';
    resultTableBody.innerHTML = '<tr><td colspan="6" class="empty-state">Select a learner to load results.</td></tr>';
  }

  if (!filtered.length) {
    const emptyMessage = !students.length
      ? "No learners found."
      : studentContactFilter.value === "missing"
        ? "All learners have at least one registered guardian contact."
        : studentContactFilter.value === "registered"
          ? "No learners with registered guardian contacts match this search."
          : "No matching learners.";
    studentList.innerHTML = `<p class="empty-state">${emptyMessage}</p>`;
    return;
  }

  studentList.innerHTML = filtered.map((student) => `
    <button class="student-item${String(student.id) === String(selectedStudentId) ? " selected" : ""}" type="button" data-student-id="${escapeHtml(student.id)}">
      <span class="student-avatar" aria-hidden="true">${escapeHtml(getInitials(student.name))}</span>
      <span class="student-item-copy">
        <strong>${escapeHtml(student.name)}</strong>
        <span>${escapeHtml(student.className || "Class not set")} · ${escapeHtml(student.admissionNumber || "No admission no.")}</span>
      </span>
      <span class="student-record-count">${escapeHtml(student.guardianCount || 0)} contacts</span>
    </button>
  `).join("");
}

function getFilteredStudents() {
  const query = studentSearch.value.trim().toLowerCase();
  return students.filter((student) => (
    `${student.name} ${student.admissionNumber} ${student.className || ""}`.toLowerCase().includes(query)
    && (!studentClassFilter.value || student.className === studentClassFilter.value)
    && (!studentContactFilter.value
      || (studentContactFilter.value === "missing" ? Number(student.guardianCount) === 0 : Number(student.guardianCount) > 0))
  ));
}

function quoteStudentCsvCell(value) {
  const cell = String(value ?? "");
  const safeCell = /^[\t\r\n ]*[=+\-@]/.test(cell) ? `'${cell}` : cell;
  return `"${safeCell.replace(/"/g, '""')}"`;
}

function downloadStudentRegisterCsv() {
  const filtered = getFilteredStudents();
  if (!filtered.length) return;

  const rows = [
    ["admissionNumber", "name", "className", "year", "guardianContactCount"],
    ...filtered.map((student) => [
      student.admissionNumber,
      student.name,
      student.className,
      student.year,
      student.guardianCount,
    ]),
  ];
  const csv = rows.map((row) => row.map(quoteStudentCsvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `msongola-learner-register-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function renderStudentGuardians(guardians = []) {
  const guardianList = document.getElementById("selectedStudentGuardians");
  if (!guardians.length) {
    guardianList.innerHTML = '<p class="empty-state">No parent or guardian contact is registered for this learner.</p>';
    return;
  }
  guardianList.innerHTML = guardians.map((guardian) => `
    <article class="learner-guardian-card">
      <span class="guardian-avatar" aria-hidden="true">${escapeHtml(getInitials(guardian.name))}</span>
      <div class="learner-guardian-copy">
        <strong>${escapeHtml(guardian.name)}</strong>
        <span>${escapeHtml(guardian.relationship || "Parent/guardian")}${guardian.isPrimary ? " · Primary contact" : ""}</span>
      </div>
      <a href="tel:${escapeHtml(guardian.phone)}">${escapeHtml(guardian.phone)}</a>
    </article>
  `).join("");
}

function renderResults(data) {
  const results = data.results || [];
  if (!results.length) {
    resultTableBody.innerHTML = '<tr><td colspan="6" class="empty-state">No results have been imported for this learner.</td></tr>';
    return;
  }

  resultTableBody.innerHTML = results.map((result) => `
    <tr>
      <td>${escapeHtml(result.subject)}</td>
      <td>${escapeHtml(result.score)}%</td>
      <td><span class="grade-badge">${escapeHtml(result.grade)}</span></td>
      <td>${escapeHtml(result.term)}</td>
      <td>${escapeHtml(result.year)}</td>
      <td>${escapeHtml(result.comment || "—")}</td>
    </tr>
  `).join("");
}

function renderOutbox(messages, statusFilter) {
  if (!messages.length) {
    const statusLabel = outboxStatusFilter.selectedOptions[0]?.textContent || "selected status";
    const emptyMessage = statusFilter
      ? `No ${escapeHtml(statusLabel.toLowerCase())} SMS messages found.`
      : "No SMS messages have been queued yet.";
    outboxTableBody.innerHTML = `<tr><td colspan="7" class="empty-state">${emptyMessage}</td></tr>`;
    return;
  }

  outboxTableBody.innerHTML = messages.map((message) => `
    <tr>
      <td><span class="table-status status-${escapeHtml(String(message.status).toLowerCase())}">${escapeHtml(message.status)}</span></td>
      <td>${escapeHtml(message.recipientPhone)}<small class="table-subtext">${escapeHtml(message.parentName || "Parent/guardian")}</small></td>
      <td>${escapeHtml(message.studentName)}<small class="table-subtext">${escapeHtml(message.admissionNumber)}</small></td>
      <td>${escapeHtml(message.examName)}<small class="table-subtext">${escapeHtml(message.term)} ${escapeHtml(message.year)}</small></td>
      <td>${formatDate(message.sentAt || message.createdAt)}${message.deliveredAt ? `<small class="table-subtext">Delivered ${formatDate(message.deliveredAt)}</small>` : ""}</td>
      <td><details class="message-details"><summary>Preview</summary><p>${escapeHtml(message.messageText)}</p></details></td>
      <td>${message.status === "FAILED"
        ? `<small class="table-subtext">${escapeHtml(message.lastError || "Delivery failed.")}</small><button class="retry-sms-button" type="button" data-retry-sms="${escapeHtml(message.id)}">Retry</button>`
        : message.lastError
          ? `<small class="table-subtext">${escapeHtml(message.lastError)}</small>`
          : "—"}</td>
    </tr>
  `).join("");
}

function renderStaffAccounts() {
  const administrators = staffAccounts.filter((account) => String(account.role).toLowerCase() === "admin").length;
  const academicMasters = staffAccounts.length - administrators;
  const searchTerm = staffAccountSearch.value.trim().toLowerCase();
  const selectedRole = staffRoleFilter.value;
  const filteredAccounts = staffAccounts.filter((account) => {
    const role = String(account.role).toLowerCase();
    const matchesSearch = `${account.name} ${account.email}`.toLowerCase().includes(searchTerm);
    return matchesSearch && (!selectedRole || role === selectedRole);
  });

  document.getElementById("staffTotalCount").textContent = String(staffAccounts.length);
  document.getElementById("staffAdminCount").textContent = String(administrators);
  document.getElementById("staffAcademicCount").textContent = String(academicMasters);
  document.getElementById("staffAccountCount").textContent =
    `${filteredAccounts.length} of ${staffAccounts.length} ${staffAccounts.length === 1 ? "staff member" : "staff members"}`;

  if (!filteredAccounts.length) {
    const hasFilters = Boolean(searchTerm || selectedRole);
    const message = staffAccounts.length === 0
      ? "No staff accounts found."
      : hasFilters
        ? "No staff accounts match your search or role filter."
        : "No staff accounts found.";
    staffAccountTableBody.innerHTML = `<tr><td colspan="4" class="empty-state">${message}</td></tr>`;
    return;
  }

  staffAccountTableBody.innerHTML = filteredAccounts.map((account) => {
    const isCurrentUser = String(account.id) === String(currentUser?.id);
    const isAdmin = String(account.role).toUpperCase() === "ADMIN";
    const roleName = isAdmin ? "Administrator" : "Academic Master";
    return `
      <tr>
        <td>
          <div class="staff-member-cell">
            <span class="staff-member-avatar ${isAdmin ? "staff-member-avatar-admin" : "staff-member-avatar-academic"}" aria-hidden="true">${escapeHtml(getInitials(account.name))}</span>
            <span class="staff-member-copy">
              <strong>${escapeHtml(account.name)}</strong>
              <span class="staff-member-email">${escapeHtml(account.email)}</span>
            </span>
            ${isCurrentUser ? '<span class="staff-you-badge">You</span>' : ""}
          </div>
        </td>
        <td><span class="staff-role-badge ${isAdmin ? "staff-role-admin" : "staff-role-academic"}"><span aria-hidden="true">${isAdmin ? "◆" : "▤"}</span>${escapeHtml(roleName)}</span></td>
        <td><span class="staff-created-date">${formatDate(account.createdAt)}</span></td>
        <td class="staff-account-actions">
          <div class="staff-action-group">
            <button class="staff-edit-button" type="button" data-edit-staff="${escapeHtml(account.id)}"><span aria-hidden="true">✎</span> Edit</button>
            ${isCurrentUser ? "" : `<button class="staff-edit-button" type="button" data-reset-staff-password="${escapeHtml(account.id)}">Reset password</button>`}
            <button class="staff-delete-button" type="button" data-delete-staff="${escapeHtml(account.id)}"${isCurrentUser ? " disabled title=\"You cannot delete your own account.\"" : ""}><span aria-hidden="true">⌫</span> Delete</button>
          </div>
        </td>
      </tr>`;
  }).join("");
}

async function loadStaffAccounts() {
  refreshStaffAccountsButton.disabled = true;
  refreshStaffAccountsButton.setAttribute("aria-busy", "true");
  staffAccountTableBody.innerHTML = '<tr><td colspan="4" class="empty-state">Loading staff accounts…</td></tr>';
  try {
    const response = await requestJson("/api/admin/users");
    staffAccounts = Array.isArray(response.data) ? response.data : [];
    renderStaffAccounts();
  } catch (error) {
    staffAccountTableBody.innerHTML = `<tr><td colspan="4" class="empty-state">${escapeHtml(error.message)}</td></tr>`;
  } finally {
    refreshStaffAccountsButton.disabled = false;
    refreshStaffAccountsButton.removeAttribute("aria-busy");
  }
}

function resetStaffAccountForm() {
  editingStaffAccountId = "";
  staffAccountForm.reset();
  document.getElementById("staffFormTitle").textContent = "Add a staff account";
  document.getElementById("staffPasswordInput").required = true;
  document.getElementById("staffPasswordHint").textContent =
    "At least 12 characters. Required for a new account.";
  document.getElementById("saveStaffAccountButton").innerHTML = '<span aria-hidden="true">＋</span> Create staff account';
  setStaffAccountFormVisibility(false);
}

function setStaffAccountFormVisibility(isVisible) {
  if (isVisible && !staffAccountModal.open) {
    staffAccountModal.showModal();
  } else if (!isVisible && staffAccountModal.open) {
    staffAccountModal.close();
  }
  document.querySelector("[data-staff-add]").setAttribute("aria-expanded", String(isVisible));
}

function openNewStaffAccountForm() {
  resetStaffAccountForm();
  setStaffAccountFormVisibility(true);
  document.getElementById("staffNameInput").focus();
}

function editStaffAccount(accountId) {
  const account = staffAccounts.find((entry) => String(entry.id) === String(accountId));
  if (!account) {
    showAppMessage("Staff account not found. Refresh the list and try again.", true);
    return;
  }

  editingStaffAccountId = String(account.id);
  setStaffAccountFormVisibility(true);
  document.getElementById("staffNameInput").value = account.name;
  document.getElementById("staffEmailInput").value = account.email;
  document.getElementById("staffRoleInput").value = String(account.role).toLowerCase();
  document.getElementById("staffPasswordInput").value = "";
  document.getElementById("staffPasswordInput").required = false;
  document.getElementById("staffFormTitle").textContent = `Edit ${account.name}`;
  document.getElementById("staffPasswordHint").textContent =
    "Leave blank to keep the current password. A new password must have at least 12 characters.";
  document.getElementById("saveStaffAccountButton").innerHTML = '<span aria-hidden="true">✓</span> Save changes';
  document.getElementById("staffNameInput").focus();
}

function closeStaffPasswordModal() {
  staffPasswordTargetId = "";
  staffPasswordForm.reset();
  if (staffPasswordModal.open) staffPasswordModal.close();
}

function openStaffPasswordModal(accountId) {
  const account = staffAccounts.find((entry) => String(entry.id) === String(accountId));
  if (!account || String(account.id) === String(currentUser?.id)) {
    showAppMessage("Select another staff account to reset its password.", true);
    return;
  }
  staffPasswordTargetId = String(account.id);
  document.getElementById("staffPasswordAccount").textContent = `${account.name} · ${account.email}`;
  staffPasswordForm.reset();
  staffPasswordModal.showModal();
  document.getElementById("staffTemporaryPasswordInput").focus();
}

async function loadBatches() {
  try {
    const response = await requestJson("/api/integrations/batches?limit=10");
    renderBatches(Array.isArray(response.data) ? response.data : []);
  } catch (error) {
    batchTableBody.innerHTML = `<tr><td colspan="6" class="empty-state">${escapeHtml(error.message)}</td></tr>`;
  }
}

function renderAdminSmsActivity(messages) {
  const body = document.getElementById("adminSmsActivityBody");
  if (!messages.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty-state">No parent SMS activity yet.</td></tr>';
    return;
  }
  body.innerHTML = messages.map((message) => `
    <tr>
      <td><span class="table-status status-${escapeHtml(String(message.status).toLowerCase())}">${escapeHtml(message.status)}</span></td>
      <td>${escapeHtml(message.parentName || "Parent/guardian")}</td>
      <td>${escapeHtml(message.studentName)}</td>
      <td>${escapeHtml(message.examName)}</td>
      <td>${formatDate(message.sentAt || message.createdAt)}</td>
      <td><details class="message-details"><summary>Preview</summary><p>${escapeHtml(message.messageText)}</p></details></td>
    </tr>
  `).join("");
}

async function loadIntegrationBatches() {
  const requestId = ++integrationBatchesRequestId;
  refreshIntegrationBatchesButton.disabled = true;
  refreshIntegrationBatchesButton.setAttribute("aria-busy", "true");
  integrationBatchTableBody.innerHTML = '<tr><td colspan="10" class="empty-state">Loading import history…</td></tr>';

  try {
    const response = await requestJson("/api/integrations/batches?limit=100");
    if (requestId !== integrationBatchesRequestId) return;
    integrationBatches = Array.isArray(response.data) ? response.data : [];
    renderIntegrationBatches();
  } catch (error) {
    if (requestId === integrationBatchesRequestId) {
      integrationBatchTableBody.innerHTML = `<tr><td colspan="10" class="empty-state">${escapeHtml(error.message)}</td></tr>`;
      document.getElementById("integrationBatchCount").textContent = "History unavailable";
    }
  } finally {
    if (requestId === integrationBatchesRequestId) {
      refreshIntegrationBatchesButton.disabled = false;
      refreshIntegrationBatchesButton.removeAttribute("aria-busy");
    }
  }
}

async function loadOutbox() {
  const requestId = ++outboxRequestId;
  const statusFilter = outboxStatusFilter.value;
  const outboxUrl = new URL("/api/sms/outbox", window.location.href);
  outboxUrl.searchParams.set("limit", "100");
  if (statusFilter) outboxUrl.searchParams.set("status", statusFilter);

  refreshOutboxButton.disabled = true;
  refreshOutboxButton.setAttribute("aria-busy", "true");
  outboxTableBody.innerHTML = '<tr><td colspan="7" class="empty-state">Loading SMS messages…</td></tr>';
  try {
    const [response, healthResponse] = await Promise.all([
      requestJson(`${outboxUrl.pathname}${outboxUrl.search}`),
      requestJson("/api/health"),
    ]);
    if (requestId !== outboxRequestId) return;
    renderOutbox(Array.isArray(response.data) ? response.data : [], statusFilter);
    const notice = document.getElementById("smsDeliveryNotice");
    notice.textContent = healthResponse.smsDeliveryConfigured
      ? `Africa's Talking is configured. ${healthResponse.smsDeliveryReportsConfigured ? "Delivery reports update the outbox when the provider confirms a result." : "SENT means accepted by the provider, not confirmed delivered; configure a private delivery-report token and callback URL to track delivery."}`
      : "Africa's Talking is not enabled. Messages remain in the outbox until valid provider credentials are configured and SMS_DELIVERY_ENABLED is true.";
    if (!healthResponse.smsDeliveryConfigured) {
      outboxTableBody.querySelectorAll("[data-retry-sms]").forEach((button) => {
        button.disabled = true;
        button.title = "Enable Africa's Talking SMS delivery before retrying.";
      });
    }
  } catch (error) {
    if (requestId === outboxRequestId) {
      outboxTableBody.innerHTML = `<tr><td colspan="7" class="empty-state">${escapeHtml(error.message)}</td></tr>`;
    }
  } finally {
    if (requestId === outboxRequestId) {
      refreshOutboxButton.disabled = false;
      refreshOutboxButton.removeAttribute("aria-busy");
    }
  }
}

async function loadIntegrationReadiness() {
  const readiness = document.getElementById("integrationReadiness");
  try {
    const response = await requestJson("/api/health");
    const data = response || {};
    if (data.resultsIntegrationConfigured) {
      readiness.textContent = data.dbConnected
        ? `Results API is configured and the database is connected. Africa's Talking SMS delivery is ${data.smsDeliveryConfigured ? "enabled" : "not enabled"}; delivery reports are ${data.smsDeliveryReportsConfigured ? "configured" : "not configured"}.`
        : "Integration key is configured, but the database is not connected. Approved batches cannot be imported yet.";
    } else {
      readiness.textContent = `Results API is disabled until RESULTS_INTEGRATION_KEY (at least 32 characters) is set in Backend/.env. Africa's Talking SMS delivery is ${data.smsDeliveryConfigured ? "enabled" : "not enabled"}; delivery reports are ${data.smsDeliveryReportsConfigured ? "configured" : "not configured"}.`;
    }
  } catch (error) {
    readiness.textContent = `Could not check integration status: ${error.message}`;
  }
}

function setDashboardReadiness(id, state, label, detail) {
  const status = document.getElementById(`${id}ReadinessStatus`);
  status.className = `readiness-indicator is-${state}`;
  status.textContent = label;
  document.getElementById(`${id}ReadinessDetail`).textContent = detail;
}

async function loadDashboardReadiness() {
  const refreshButton = document.getElementById("refreshReadinessButton");
  refreshButton.disabled = true;
  refreshButton.setAttribute("aria-busy", "true");

  try {
    const response = await requestJson("/api/health");
    const data = response || {};
    const connectionStatus = document.getElementById("backendConnectionStatus");
    connectionStatus.classList.remove("is-checking", "is-offline");
    connectionStatus.setAttribute("aria-label", "Server is responding");
    connectionStatus.title = "Server is responding";
    setDashboardReadiness(
      "database",
      data.dbConnected ? "ready" : "error",
      data.dbConnected ? "Connected" : "Unavailable",
      data.dbConnected ? "The dashboard can reach its database." : "Database is unreachable. Check the backend connection."
    );
    setDashboardReadiness(
      "results",
      data.resultsIntegrationConfigured ? "ready" : "setup",
      data.resultsIntegrationConfigured ? "Configured" : "Needs setup",
      data.resultsIntegrationConfigured
        ? "Approved-results imports are enabled."
        : "Set RESULTS_INTEGRATION_KEY before connecting the school system."
    );
    setDashboardReadiness(
      "sms",
      data.smsDeliveryConfigured ? "ready" : "setup",
      data.smsDeliveryConfigured ? "Enabled" : "Not enabled",
      data.smsDeliveryConfigured
        ? "The SMS gateway is ready to send queued messages."
        : "Messages stay queued until Africa's Talking is configured and enabled."
    );
    setDashboardReadiness(
      "reports",
      data.smsDeliveryReportsConfigured ? "ready" : "setup",
      data.smsDeliveryReportsConfigured ? "Configured" : "Not configured",
      data.smsDeliveryReportsConfigured
        ? "Provider reports can update delivery outcomes."
        : "Configure the delivery token and a public HTTPS callback URL."
    );
  } catch (error) {
    const connectionStatus = document.getElementById("backendConnectionStatus");
    connectionStatus.classList.remove("is-checking");
    connectionStatus.classList.add("is-offline");
    connectionStatus.setAttribute("aria-label", "Server is unavailable");
    connectionStatus.title = "Server is unavailable";
    ["database", "results", "sms", "reports"].forEach((id) => {
      setDashboardReadiness(id, "error", "Unavailable", `Could not check system status: ${error.message}`);
    });
  } finally {
    refreshButton.disabled = false;
    refreshButton.removeAttribute("aria-busy");
  }
}

async function loadWorkspace() {
  const refreshButton = document.getElementById("refreshDashboardButton");
  const isAdmin = String(currentUser?.role || "").toUpperCase() === "ADMIN";
  refreshButton.disabled = true;
  refreshButton.setAttribute("aria-busy", "true");
  if (isAdmin) loadDashboardReadiness();
  try {
    if (isAdmin) {
      const [dashboardResponse, outboxResponse] = await Promise.all([
        requestJson("/api/dashboard/summary"),
        requestJson("/api/sms/outbox?limit=5"),
      ]);
      const dashboard = dashboardResponse.data || {};
      document.getElementById("staffCount").textContent = dashboard.staffCount ?? 0;
      document.getElementById("pendingSmsCount").textContent = dashboard.pendingSmsCount ?? 0;
      document.getElementById("failedSmsCount").textContent = dashboard.failedSmsCount ?? 0;
      document.getElementById("adminBatchCount").textContent = dashboard.importBatchCount ?? 0;
      renderAdminSmsActivity(Array.isArray(outboxResponse.data) ? outboxResponse.data : []);
    } else {
      const [dashboardResponse, summaryResponse, batchResponse] = await Promise.all([
        requestJson("/api/dashboard/summary"),
        requestJson("/api/reports/summary"),
        requestJson("/api/integrations/batches?limit=10"),
      ]);
      const dashboard = dashboardResponse.data || {};
      document.getElementById("studentCount").textContent = dashboard.studentCount ?? 0;
      const learnerCount = Number(dashboard.studentCount || 0);
      const learnersWithGuardians = Number(dashboard.learnersWithGuardiansCount || 0);
      const learnersMissingGuardians = Number(dashboard.learnersMissingGuardiansCount || 0);
      const contactCoverage = learnerCount
        ? Math.round((learnersWithGuardians / learnerCount) * 100)
        : 0;
      document.getElementById("learnersWithGuardiansCount").textContent = learnersWithGuardians;
      document.getElementById("learnersMissingGuardiansCount").textContent = learnersMissingGuardians;
      document.getElementById("contactReadinessDescription").textContent = learnerCount
        ? `${learnersWithGuardians} of ${learnerCount} learners have at least one registered guardian contact.`
        : "Register learner and guardian details here before preparing parent result notifications.";
      document.getElementById("contactReadinessPercentage").textContent =
        `${contactCoverage}% of learners have at least one linked contact`;
      const contactProgress = document.querySelector(".contact-readiness-progress");
      contactProgress.setAttribute("aria-valuenow", String(contactCoverage));
      document.getElementById("contactReadinessProgress").style.width = `${contactCoverage}%`;
      document.getElementById("reviewMissingGuardiansButton").disabled = learnersMissingGuardians === 0;
      document.getElementById("resultCount").textContent = dashboard.resultCount ?? 0;
      document.getElementById("subjectCount").textContent = dashboard.subjectCount ?? 0;
      document.getElementById("academicBatchCount").textContent = dashboard.importBatchCount ?? 0;
      renderSummary(Array.isArray(summaryResponse.data) ? summaryResponse.data : []);
      renderBatches(Array.isArray(batchResponse.data) ? batchResponse.data : []);
    }
  } catch (error) {
    showAppMessage(error.message, true);
    showUnavailableDashboard();
    if (!isAdmin) {
      summaryTableBody.innerHTML = `<tr><td colspan="5" class="empty-state">${escapeHtml(error.message)}</td></tr>`;
      batchTableBody.innerHTML = `<tr><td colspan="6" class="empty-state">${escapeHtml(error.message)}</td></tr>`;
    } else {
      document.getElementById("adminSmsActivityBody").innerHTML =
        `<tr><td colspan="5" class="empty-state">${escapeHtml(error.message)}</td></tr>`;
    }
  } finally {
    refreshButton.disabled = false;
    refreshButton.removeAttribute("aria-busy");
  }
}

function showUnavailableDashboard() {
  ["studentCount", "resultCount", "subjectCount", "pendingSmsCount", "failedSmsCount",
    "staffCount", "adminBatchCount", "academicBatchCount", "learnersWithGuardiansCount",
    "learnersMissingGuardiansCount"].forEach((id) => {
    document.getElementById(id).textContent = "—";
  });
  document.getElementById("contactReadinessDescription").textContent = "Guardian contact coverage is unavailable.";
  document.getElementById("contactReadinessPercentage").textContent = "Contact coverage —";
  document.querySelector(".contact-readiness-progress").setAttribute("aria-valuenow", "0");
  document.getElementById("contactReadinessProgress").style.width = "0%";
  document.getElementById("reviewMissingGuardiansButton").disabled = true;
}

async function loadStudents() {
  studentList.innerHTML = '<p class="empty-state">Loading learners…</p>';
  try {
    const response = await requestJson("/api/students");
    students = Array.isArray(response.data) ? response.data : [];
    studentsLoaded = true;
    renderStudentList();
    if (students.length && !selectedStudentId) {
      await loadSelectedStudent(students[0].id);
    } else if (selectedStudentId && students.some((student) => String(student.id) === selectedStudentId)) {
      await loadSelectedStudent(selectedStudentId);
    } else if (!students.length) {
      selectedStudentId = "";
      selectedStudentRecord = null;
      document.getElementById("selectedStudentName").textContent = "Select a learner";
      document.getElementById("selectedStudentMeta").textContent = "Choose a learner from the list to see their details and results.";
      document.getElementById("editStudentButton").disabled = true;
      document.getElementById("selectedStudentGuardians").innerHTML =
        '<p class="empty-state">Select a learner to view registered contacts.</p>';
      resultTableBody.innerHTML = '<tr><td colspan="6" class="empty-state">Select a learner to load results.</td></tr>';
    }
  } catch (error) {
    studentList.innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`;
    showAppMessage(error.message, true);
  }
}

function createStudentGuardianRow(guardian = {}) {
  if (studentGuardianFields.children.length >= 10) {
    showAppMessage("A learner can have at most 10 guardian contacts.", true);
    return;
  }
  const row = document.createElement("div");
  row.className = "student-guardian-row";
  row.innerHTML = `
    <label class="guardian-primary-choice">
      <input type="radio" name="studentPrimaryGuardian" aria-label="Set as primary guardian" />
      <span>Primary</span>
    </label>
    <label>Guardian name
      <input type="text" maxlength="120" data-guardian-name autocomplete="name" />
    </label>
    <label>Phone number
      <input type="tel" maxlength="30" data-guardian-phone placeholder="+255712345678" autocomplete="tel" />
    </label>
    <label>Relationship
      <input type="text" maxlength="50" data-guardian-relationship placeholder="e.g. Mother" />
    </label>
    <button class="guardian-remove-button" type="button" aria-label="Remove guardian contact" title="Remove contact">×</button>
  `;
  row.querySelector("[data-guardian-name]").value = guardian.name || "";
  row.querySelector("[data-guardian-phone]").value = guardian.phone || "";
  row.querySelector("[data-guardian-relationship]").value = guardian.relationship || "";
  const primaryInput = row.querySelector('input[type="radio"]');
  primaryInput.checked = Boolean(guardian.isPrimary) || studentGuardianFields.children.length === 0;
  row.querySelector(".guardian-remove-button").addEventListener("click", () => {
    const wasPrimary = primaryInput.checked;
    row.remove();
    if (wasPrimary) {
      const firstPrimary = studentGuardianFields.querySelector('input[type="radio"]');
      if (firstPrimary) firstPrimary.checked = true;
    }
  });
  studentGuardianFields.append(row);
}

function resetStudentRecordForm() {
  editingStudentId = "";
  studentRecordForm.reset();
  studentGuardianFields.replaceChildren();
  document.getElementById("studentRecordTitle").textContent = "Add learner";
  document.getElementById("saveStudentRecordButton").textContent = "Save learner";
  if (studentRecordModal.open) studentRecordModal.close();
}

function openNewStudentRecordForm() {
  resetStudentRecordForm();
  document.getElementById("studentYearInput").value = String(new Date().getFullYear());
  createStudentGuardianRow();
  studentRecordModal.showModal();
  document.getElementById("studentNameInput").focus();
}

function openEditStudentRecordForm() {
  if (!selectedStudentRecord) {
    showAppMessage("Select a learner and try again.", true);
    return;
  }
  const student = selectedStudentRecord;
  editingStudentId = String(student.id);
  document.getElementById("studentRecordTitle").textContent = `Edit ${student.name}`;
  document.getElementById("saveStudentRecordButton").textContent = "Save changes";
  document.getElementById("studentNameInput").value = student.name || "";
  document.getElementById("studentAdmissionInput").value = student.admissionNumber || "";
  document.getElementById("studentClassInput").value = student.className || "";
  document.getElementById("studentYearInput").value = student.year || "";
  studentGuardianFields.replaceChildren();
  (student.guardians || []).forEach((guardian) => createStudentGuardianRow(guardian));
  if (!studentGuardianFields.children.length) createStudentGuardianRow();
  studentRecordModal.showModal();
  document.getElementById("studentNameInput").focus();
}

function buildStudentRecordPayload() {
  const guardians = [...studentGuardianFields.querySelectorAll(".student-guardian-row")]
    .map((row) => ({
      name: row.querySelector("[data-guardian-name]").value.trim(),
      phone: row.querySelector("[data-guardian-phone]").value.trim(),
      relationship: row.querySelector("[data-guardian-relationship]").value.trim(),
      isPrimary: row.querySelector('input[type="radio"]').checked,
    }))
    .filter((guardian) => guardian.name || guardian.phone || guardian.relationship);
  return {
    name: document.getElementById("studentNameInput").value.trim(),
    admissionNumber: document.getElementById("studentAdmissionInput").value.trim(),
    className: document.getElementById("studentClassInput").value.trim(),
    year: Number(document.getElementById("studentYearInput").value),
    guardians,
  };
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const csv = text.replace(/^\uFEFF/, "");

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (inQuotes) {
      if (character === '"' && csv[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        inQuotes = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      inQuotes = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && csv[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (inQuotes) throw new Error("The CSV file contains an unclosed quoted field.");
  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function parseStudentCsv(text) {
  const rows = parseCsvRows(text);
  if (rows.length < 2) throw new Error("The CSV file needs a header row and at least one learner.");
  const headers = rows[0].map((header) => header.trim());
  const requiredHeaders = ["name", "className", "year"];
  const missingHeaders = requiredHeaders.filter((header) => !headers.includes(header));
  if (missingHeaders.length) {
    throw new Error(`The CSV is missing required columns: ${missingHeaders.join(", ")}.`);
  }
  if (new Set(headers).size !== headers.length) throw new Error("The CSV header row contains duplicate column names.");
  if (rows.length - 1 > 500) throw new Error("A CSV file can contain at most 500 learner records.");

  const records = [];
  const errors = [];
  const admissions = new Set();
  rows.slice(1).forEach((values, index) => {
    const csvRow = index + 2;
    const columns = Object.fromEntries(headers.map((header, column) => [header, (values[column] || "").trim()]));
    const record = {
      csvRow,
      admissionNumber: columns.admissionNumber || "",
      name: columns.name,
      className: columns.className,
      year: Number(columns.year),
      guardians: [],
    };
    const rowErrors = [];
    if (record.admissionNumber.length > 50) rowErrors.push("Admission number must be 50 characters or fewer.");
    if (!record.name || record.name.length > 120) rowErrors.push("Learner name is required (max 120 characters).");
    if (!record.className || record.className.length > 80) rowErrors.push("Class is required (max 80 characters).");
    if (!Number.isInteger(record.year) || record.year < 2000 || record.year > 2100) rowErrors.push("Academic year must be from 2000 to 2100.");

    const admissionKey = record.admissionNumber.toLocaleLowerCase();
    if (admissionKey && admissions.has(admissionKey)) rowErrors.push("Admission number is repeated in this file.");
    if (admissionKey) admissions.add(admissionKey);

    const guardianPhones = new Set();
    for (let guardianIndex = 1; guardianIndex <= 10; guardianIndex += 1) {
      const guardianName = columns[`guardian${guardianIndex}Name`] || "";
      const phone = columns[`guardian${guardianIndex}Phone`] || "";
      const relationship = columns[`guardian${guardianIndex}Relationship`] || "";
      const primaryValue = (columns[`guardian${guardianIndex}IsPrimary`] || "").toLowerCase();
      if (!guardianName && !phone && !relationship && !primaryValue) continue;

      if (!guardianName || guardianName.length > 120) {
        rowErrors.push(`Guardian ${guardianIndex} needs a name (max 120 characters).`);
      }
      if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
        rowErrors.push(`Guardian ${guardianIndex} phone must use international format, e.g. +255712345678.`);
      }
      if (phone && guardianPhones.has(phone)) rowErrors.push(`Guardian ${guardianIndex} phone is repeated for this learner.`);
      if (phone) guardianPhones.add(phone);
      if (relationship.length > 50) rowErrors.push(`Guardian ${guardianIndex} relationship must be 50 characters or fewer.`);
      if (primaryValue && !["true", "yes", "1", "false", "no", "0"].includes(primaryValue)) {
        rowErrors.push(`Guardian ${guardianIndex} primary flag must be true or false.`);
      }
      record.guardians.push({
        name: guardianName,
        phone,
        relationship,
        isPrimary: ["true", "yes", "1"].includes(primaryValue),
      });
    }
    if (record.guardians.length && record.guardians.filter((guardian) => guardian.isPrimary).length !== 1) {
      rowErrors.push("Mark exactly one guardian as primary using true.");
    }
    records.push(record);
    rowErrors.forEach((message) => errors.push({ row: csvRow, message }));
  });
  return { records, errors };
}

function renderStudentCsvPreview() {
  const validCount = studentCsvRecords.length - new Set(studentCsvErrors.map((error) => error.row)).size;
  const summary = document.getElementById("studentCsvPreviewSummary");
  summary.textContent = studentCsvErrors.length
    ? `${validCount} valid of ${studentCsvRecords.length} rows. Fix all ${studentCsvErrors.length} issue(s) in the CSV and upload it again. No rows can be imported until the whole file is valid.`
    : `${studentCsvRecords.length} learner records are ready. Review the preview, then confirm to save them together.`;
  confirmStudentCsvImportButton.disabled = Boolean(studentCsvErrors.length) || !studentCsvRecords.length;

  const errorsByRow = new Map();
  studentCsvErrors.forEach((error) => {
    errorsByRow.set(error.row, [...(errorsByRow.get(error.row) || []), error.message]);
  });
  studentCsvPreviewBody.innerHTML = studentCsvRecords.map((record) => {
    const rowErrors = errorsByRow.get(record.csvRow) || [];
    return `
      <tr>
        <td>${record.csvRow}</td>
        <td>${escapeHtml(record.name)}</td>
        <td>${escapeHtml(record.admissionNumber || "Assigned on import")}</td>
        <td>${escapeHtml(record.className)}<small class="table-subtext">${escapeHtml(record.year || "—")}</small></td>
        <td>${record.guardians.length}</td>
        <td class="${rowErrors.length ? "student-csv-row-error" : "student-csv-row-valid"}">${rowErrors.length ? escapeHtml(rowErrors.join(" ")) : "Ready"}</td>
      </tr>
    `;
  }).join("");
  studentCsvErrorList.classList.toggle("hidden", !studentCsvErrors.length);
  studentCsvErrorList.textContent = studentCsvErrors.length
    ? `Import blocked: ${studentCsvErrors.length} issue(s) found across ${new Set(studentCsvErrors.map((error) => error.row)).size} CSV row(s). Correct the file and select it again.`
    : "";
}

function downloadStudentCsvTemplate() {
  const headers = ["admissionNumber", "name", "className", "year"];
  for (let guardianIndex = 1; guardianIndex <= 3; guardianIndex += 1) {
    headers.push(
      `guardian${guardianIndex}Name`,
      `guardian${guardianIndex}Phone`,
      `guardian${guardianIndex}Relationship`,
      `guardian${guardianIndex}IsPrimary`
    );
  }
  const sample = [
    "",
    "Sample Learner",
    "Form 1",
    String(new Date().getFullYear()),
    "Sample Parent",
    "+255712345678",
    "Mother",
    "true",
  ];
  const csv = [headers, sample].map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "msongola-learner-import-template.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function setReportFilterOptions(id, label, values) {
  const select = document.getElementById(id);
  const selectedValue = select.value;
  const options = [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ""))]
    .sort((left, right) => String(left).localeCompare(String(right), undefined, { numeric: true }));
  select.replaceChildren(new Option(`All ${label}`, ""));
  options.forEach((value) => select.add(new Option(String(value), String(value))));
  select.value = options.some((value) => String(value) === selectedValue) ? selectedValue : "";
}

function getReportPerformance() {
  const assessments = new Map();
  for (const row of academicReportRows) {
    const assessmentKey = JSON.stringify([
      row.className,
      row.importBatchId ?? row.examName ?? "",
      row.term,
      row.year,
    ]);
    const learners = assessments.get(assessmentKey) || new Map();
    const learnerKey = row.admissionNumber;
    const learner = learners.get(learnerKey) || {
      results: [],
      division: row.division || null,
      totalPoints: row.totalPoints !== null && row.totalPoints !== undefined && Number.isInteger(Number(row.totalPoints))
        ? Number(row.totalPoints)
        : null,
      classPosition: Number.isInteger(Number(row.classPosition)) && Number(row.classPosition) > 0
        ? Number(row.classPosition)
        : null,
    };
    learner.results.push(row);
    if (!learner.division && row.division) learner.division = row.division;
    if (learner.totalPoints === null && row.totalPoints !== null && row.totalPoints !== undefined &&
      Number.isInteger(Number(row.totalPoints))) {
      learner.totalPoints = Number(row.totalPoints);
    }
    if (learner.classPosition === null && Number.isInteger(Number(row.classPosition)) && Number(row.classPosition) > 0) {
      learner.classPosition = Number(row.classPosition);
    }
    learners.set(learnerKey, learner);
    assessments.set(assessmentKey, learners);
  }

  const performance = new Map();
  for (const [assessmentKey, learners] of assessments) {
    const rankedLearners = [...learners.entries()].map(([admissionNumber, learner]) => {
      const totalScore = learner.results.reduce((total, row) => total + Number(row.score || 0), 0);
      return {
        admissionNumber,
        averageScore: learner.results.length ? totalScore / learner.results.length : null,
        division: learner.division,
        totalPoints: learner.totalPoints,
        classPosition: learner.classPosition,
      };
    }).filter((learner) => learner.averageScore !== null)
      .sort((left, right) => right.averageScore - left.averageScore);
    let position = 0;
    let previousAverage = null;
    rankedLearners.forEach((learner, index) => {
      if (previousAverage === null || Math.abs(learner.averageScore - previousAverage) > 1e-9) {
        position = index + 1;
        previousAverage = learner.averageScore;
      }
      performance.set(JSON.stringify([assessmentKey, learner.admissionNumber]), {
        ...learner,
        position: learner.classPosition ?? position,
      });
    });
  }
  return performance;
}

function reportPerformanceFor(row, performance) {
  const assessmentKey = JSON.stringify([
    row.className,
    row.importBatchId ?? row.examName ?? "",
    row.term,
    row.year,
  ]);
  return performance.get(JSON.stringify([assessmentKey, row.admissionNumber])) || {};
}

function renderResultsReport() {
  const classFilter = document.getElementById("reportClassFilter").value;
  const subjectFilter = document.getElementById("reportSubjectFilter").value;
  const termFilter = document.getElementById("reportTermFilter").value;
  const yearFilter = document.getElementById("reportYearFilter").value;
  const rows = academicReportRows.filter((row) => (
    (!classFilter || row.className === classFilter)
    && (!subjectFilter || row.subject === subjectFilter)
    && (!termFilter || row.term === termFilter)
    && (!yearFilter || String(row.year) === yearFilter)
  ));
  const performance = getReportPerformance();
  const learnerCount = new Set(rows.map((row) => row.admissionNumber)).size;
  const averageScore = rows.length
    ? rows.reduce((total, row) => total + Number(row.score || 0), 0) / rows.length
    : null;
  document.getElementById("reportResultCount").textContent =
    `${rows.length} ${rows.length === 1 ? "result" : "results"}`;
  document.getElementById("reportLearnerCount").textContent =
    `${learnerCount} ${learnerCount === 1 ? "learner" : "learners"}`;
  document.getElementById("reportAverageScore").textContent =
    `Average score ${averageScore === null ? "—" : `${averageScore.toFixed(1)}%`}`;
  document.getElementById("exportResultsReportButton").disabled = rows.length === 0;
  document.getElementById("printResultsReportButton").disabled = rows.length === 0;
  const selectedFilters = [
    ["Class", "reportClassFilter"],
    ["Subject", "reportSubjectFilter"],
    ["Term", "reportTermFilter"],
    ["Year", "reportYearFilter"],
  ].flatMap(([label, id]) => {
    const select = document.getElementById(id);
    return select.value
      ? [`${label}: ${select.selectedOptions[0].textContent}`]
      : [];
  });
  document.getElementById("reportPrintFilters").textContent =
    selectedFilters.length ? selectedFilters.join(" · ") : "All classes, subjects, terms and years";
  document.getElementById("reportPrintDate").textContent =
    `Generated ${new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(new Date())}`;

  if (!rows.length) {
    resultsReportTableBody.innerHTML = `    <tr><td colspan="13" class="empty-state">${academicReportRows.length
      ? "No results match the selected filters."
      : "No learner results are available yet."}</td></tr>`;
    return;
  }
  resultsReportTableBody.innerHTML = rows.map((row) => `
    <tr>
      ${(() => {
    const learnerPerformance = reportPerformanceFor(row, performance);
    return `
      <td>${escapeHtml(row.studentName)}</td>
      <td>${escapeHtml(row.admissionNumber)}</td>
      <td>${escapeHtml(row.className)}</td>
      <td>${escapeHtml(row.subject)}</td>
      <td>${escapeHtml(row.score)}%</td>
      <td><span class="grade-badge">${escapeHtml(row.grade)}</span></td>
      <td>${learnerPerformance.averageScore === undefined ? "—" : `${learnerPerformance.averageScore.toFixed(1)}%`}</td>
      <td>${escapeHtml(learnerPerformance.division || "—")}</td>
      <td>${learnerPerformance.totalPoints === null || learnerPerformance.totalPoints === undefined ? "—" : learnerPerformance.totalPoints}</td>
      <td>${learnerPerformance.position === undefined ? "—" : learnerPerformance.position}</td>
      <td>${escapeHtml(row.term)}</td>
      <td>${escapeHtml(row.year)}</td>
      <td>${escapeHtml(row.comment || "—")}</td>
    `;
  })()}
    </tr>
  `).join("");
}

async function loadResultsReport() {
  const refreshButton = document.getElementById("refreshResultsReportButton");
  refreshButton.disabled = true;
  refreshButton.setAttribute("aria-busy", "true");
  resultsReportTableBody.innerHTML = '<tr><td colspan="13" class="empty-state">Loading academic results…</td></tr>';
  try {
    const response = await requestJson("/api/reports/results");
    academicReportRows = Array.isArray(response.data) ? response.data : [];
    reportLoaded = true;
    setReportFilterOptions("reportClassFilter", "classes", academicReportRows.map((row) => row.className));
    setReportFilterOptions("reportSubjectFilter", "subjects", academicReportRows.map((row) => row.subject));
    setReportFilterOptions("reportTermFilter", "terms", academicReportRows.map((row) => row.term));
    setReportFilterOptions("reportYearFilter", "years", academicReportRows.map((row) => row.year));
    renderResultsReport();
  } catch (error) {
    academicReportRows = [];
    reportLoaded = false;
    document.getElementById("reportResultCount").textContent = "— results";
    document.getElementById("reportLearnerCount").textContent = "— learners";
    document.getElementById("reportAverageScore").textContent = "Average score —";
    document.getElementById("exportResultsReportButton").disabled = true;
    document.getElementById("printResultsReportButton").disabled = true;
    resultsReportTableBody.innerHTML =
      `<tr><td colspan="13" class="empty-state">${escapeHtml(error.message)}</td></tr>`;
    showAppMessage(error.message, true);
  } finally {
    refreshButton.disabled = false;
    refreshButton.removeAttribute("aria-busy");
  }
}

function exportResultsReport() {
  const classFilter = document.getElementById("reportClassFilter").value;
  const subjectFilter = document.getElementById("reportSubjectFilter").value;
  const termFilter = document.getElementById("reportTermFilter").value;
  const yearFilter = document.getElementById("reportYearFilter").value;
  const rows = academicReportRows.filter((row) => (
    (!classFilter || row.className === classFilter)
    && (!subjectFilter || row.subject === subjectFilter)
    && (!termFilter || row.term === termFilter)
    && (!yearFilter || String(row.year) === yearFilter)
  ));
  const performance = getReportPerformance();
  if (!rows.length) {
    showAppMessage("There are no results to export for the selected filters.", true);
    return;
  }

  const columns = [
    ["Learner", "studentName"],
    ["Admission number", "admissionNumber"],
    ["Class", "className"],
    ["Subject", "subject"],
    ["Score", "score"],
    ["Grade", "grade"],
    ["Average", "averageScore"],
    ["Division", "division"],
    ["Total points", "totalPoints"],
    ["Class position", "position"],
    ["Term", "term"],
    ["Year", "year"],
    ["Comment", "comment"],
  ];
  const csvCell = (value) => {
    const text = String(value ?? "");
    const safeText = /^[\t\r\n ]*[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safeText.replaceAll('"', '""')}"`;
  };
  const csv = [
    columns.map(([heading]) => csvCell(heading)).join(","),
    ...rows.map((row) => {
      const learnerPerformance = reportPerformanceFor(row, performance);
      return columns.map(([, key]) => csvCell(
        key === "averageScore" ? learnerPerformance.averageScore?.toFixed(1) :
          key === "division" ? learnerPerformance.division :
            key === "totalPoints" ? learnerPerformance.totalPoints :
            key === "position" ? learnerPerformance.position : row[key]
      )).join(",");
    }),
  ].join("\r\n");
  const file = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);
  link.href = url;
  link.download = `msongola-results-${date}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function printResultsReport() {
  if (document.getElementById("printResultsReportButton").disabled) {
    showAppMessage("Load results before printing a report.", true);
    return;
  }
  document.body.classList.add("printing-results-report");
  window.addEventListener("afterprint", () => {
    document.body.classList.remove("printing-results-report");
  }, { once: true });
  window.print();
}

async function loadSelectedStudent(studentId) {
  selectedStudentId = String(studentId);
  selectedStudentRecord = null;
  renderStudentList();
  document.getElementById("selectedStudentName").textContent = "Loading learner…";
  document.getElementById("selectedStudentMeta").textContent = "";
  document.getElementById("editStudentButton").disabled = true;
  document.getElementById("selectedStudentGuardians").innerHTML =
    '<p class="empty-state">Loading guardian contacts…</p>';
  resultTableBody.innerHTML = '<tr><td colspan="6" class="empty-state">Loading results…</td></tr>';

  try {
    const [resultsResponse, studentResponse] = await Promise.all([
      requestJson(`/api/results/${encodeURIComponent(selectedStudentId)}`),
      requestJson(`/api/students/${encodeURIComponent(selectedStudentId)}`),
    ]);
    const data = resultsResponse.data || {};
    selectedStudentRecord = studentResponse.data || null;
    document.getElementById("selectedStudentName").textContent = data.studentName || selectedStudentRecord?.name || "Learner";
    document.getElementById("selectedStudentMeta").textContent =
      `${data.className || "Class not set"} · Admission ${data.admissionNumber || "not recorded"} · Academic year ${selectedStudentRecord?.year || "not recorded"}`;
    document.getElementById("editStudentButton").disabled = !selectedStudentRecord;
    renderStudentGuardians(selectedStudentRecord?.guardians || []);
    renderResults(data);
  } catch (error) {
    document.getElementById("selectedStudentName").textContent = "Could not load learner";
    document.getElementById("selectedStudentMeta").textContent = error.message;
    document.getElementById("selectedStudentGuardians").innerHTML =
      `<p class="empty-state">${escapeHtml(error.message)}</p>`;
    resultTableBody.innerHTML = `<tr><td colspan="6" class="empty-state">${escapeHtml(error.message)}</td></tr>`;
    showAppMessage(error.message, true);
  }
}

async function restoreSession() {
  if (!authToken) return;

  try {
    const response = await requestJson("/api/profile");
    const user = response.user || {};
    const role = String(user.role || "").toUpperCase();
    if (role !== "ADMIN" && role !== "ACADEMIC_MASTER") {
      signOut("This account cannot access the staff workspace.");
      return;
    }
    showApplication(user);
    await loadWorkspace();
  } catch (error) {
    signOut("Please sign in to continue.");
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginButton.disabled = true;
  loginButton.querySelector("span:first-child").textContent = "Signing in…";
  setLoginMessage("", false);

  try {
    const response = await requestJson("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: document.getElementById("email").value.trim(),
        password: document.getElementById("password").value,
      }),
    });
    const role = String(response.user?.role || "").toUpperCase();
    if (!response.success || !response.token || (role !== "ADMIN" && role !== "ACADEMIC_MASTER")) {
      throw new Error("This account does not have staff access.");
    }

    authToken = response.token;
    sessionStorage.setItem("msongolaAdminToken", authToken);
    showApplication(response.user);
    await loadWorkspace();
  } catch (error) {
    setLoginMessage(error.message);
  } finally {
    loginButton.disabled = false;
    loginButton.querySelector("span:first-child").textContent = "Sign in to your workspace";
  }
});

document.querySelectorAll(".nav-link").forEach((link) => {
  link.addEventListener("click", () => setView(link.dataset.view));
});

document.querySelectorAll("[data-open-view]").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.openView));
});

document.querySelectorAll("[data-academic-action='add-learner']").forEach((button) => {
  button.addEventListener("click", () => {
    setView("studentsView");
    openNewStudentRecordForm();
  });
});

document.getElementById("logoutButton").addEventListener("click", () => signOut());
document.getElementById("profileSignOutButton").addEventListener("click", () => signOut());
document.getElementById("profilePasswordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const currentPassword = document.getElementById("currentProfilePassword").value;
  const newPassword = document.getElementById("newProfilePassword").value;
  const confirmPassword = document.getElementById("confirmProfilePassword").value;
  const saveButton = document.getElementById("saveProfilePasswordButton");
  const message = document.getElementById("profilePasswordMessage");
  message.textContent = "";
  message.classList.remove("error", "success");
  if (newPassword !== confirmPassword) {
    message.textContent = "The new password and confirmation do not match.";
    message.classList.add("error");
    return;
  }

  saveButton.disabled = true;
  try {
    const response = await requestJson("/api/profile/password", {
      method: "PATCH",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    document.getElementById("profilePasswordForm").reset();
    message.textContent = response.message || "Your password has been changed.";
    message.classList.add("success");
  } catch (error) {
    message.textContent = error.message || "Unable to change your password.";
    message.classList.add("error");
  } finally {
    saveButton.disabled = false;
  }
});
staffPasswordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = document.getElementById("staffTemporaryPasswordInput").value;
  const confirmPassword = document.getElementById("staffTemporaryPasswordConfirmInput").value;
  const saveButton = document.getElementById("saveStaffPasswordButton");
  if (!staffPasswordTargetId) return;
  if (password !== confirmPassword) {
    showAppMessage("The temporary password and confirmation do not match.", true);
    return;
  }
  const account = staffAccounts.find((entry) => String(entry.id) === staffPasswordTargetId);
  if (!account || !window.confirm(`Set a new temporary password for ${account.name}? They will need to use it at their next sign-in.`)) return;

  saveButton.disabled = true;
  try {
    const response = await requestJson(
      `/api/admin/users/${encodeURIComponent(staffPasswordTargetId)}/password`,
      { method: "PATCH", body: JSON.stringify({ password }) }
    );
    closeStaffPasswordModal();
    showAppMessage(response.message || "Temporary password set.");
  } catch (error) {
    showAppMessage(error.message || "Unable to reset the staff password.", true);
  } finally {
    saveButton.disabled = false;
  }
});
document.getElementById("refreshDashboardButton").addEventListener("click", loadWorkspace);
studentSearch.addEventListener("input", renderStudentList);
studentClassFilter.addEventListener("change", renderStudentList);
studentContactFilter.addEventListener("change", renderStudentList);
document.getElementById("reviewMissingGuardiansButton").addEventListener("click", () => {
  studentContactFilter.value = "missing";
  setView("studentsView");
  renderStudentList();
});
document.getElementById("addStudentButton").addEventListener("click", openNewStudentRecordForm);
document.getElementById("editStudentButton").addEventListener("click", openEditStudentRecordForm);
document.getElementById("importStudentCsvButton").addEventListener("click", () => studentCsvFileInput.click());
document.getElementById("exportStudentCsvButton").addEventListener("click", downloadStudentRegisterCsv);
studentCsvFileInput.addEventListener("change", async () => {
  const [file] = studentCsvFileInput.files || [];
  studentCsvFileInput.value = "";
  if (!file) return;
  studentCsvPreviewPanel.classList.add("hidden");
  studentCsvRecords = [];
  studentCsvErrors = [];
  if (file.size > 2 * 1024 * 1024) {
    showAppMessage("CSV files must be 2 MB or smaller.", true);
    return;
  }
  try {
    const preview = parseStudentCsv(await file.text());
    studentCsvRecords = preview.records;
    studentCsvErrors = preview.errors;
    if (studentCsvRecords.length > 500) throw new Error("A CSV file can contain at most 500 learner records.");
    studentCsvPreviewPanel.classList.remove("hidden");
    renderStudentCsvPreview();
    studentCsvPreviewPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    studentCsvRecords = [];
    studentCsvErrors = [];
    showAppMessage(error.message, true);
  }
});
document.getElementById("downloadStudentCsvTemplateButton").addEventListener("click", downloadStudentCsvTemplate);
document.getElementById("cancelStudentCsvImportButton").addEventListener("click", () => {
  studentCsvRecords = [];
  studentCsvErrors = [];
  studentCsvPreviewPanel.classList.add("hidden");
});
confirmStudentCsvImportButton.addEventListener("click", async () => {
  if (confirmStudentCsvImportButton.disabled || !studentCsvRecords.length) return;
  confirmStudentCsvImportButton.disabled = true;
  confirmStudentCsvImportButton.setAttribute("aria-busy", "true");
  try {
    const response = await requestJson("/api/students/import", {
      method: "POST",
      body: JSON.stringify({
        students: studentCsvRecords.map(({ csvRow, ...record }) => record),
      }),
    });
    const importedCount = Number(response.data?.importedCount || 0);
    const generatedNumbers = Array.isArray(response.data?.generatedAdmissionNumbers)
      ? response.data.generatedAdmissionNumbers
      : [];
    studentCsvRecords = [];
    studentCsvErrors = [];
    studentCsvPreviewPanel.classList.add("hidden");
    studentsLoaded = false;
    const generatedSummary = generatedNumbers.length
      ? ` System-assigned admission numbers: ${generatedNumbers.join(", ")}.`
      : "";
    showAppMessage(`${importedCount} learner records imported.${generatedSummary} No results or SMS messages were created.`);
    await loadStudents();
  } catch (error) {
    showAppMessage(error.message, true);
    confirmStudentCsvImportButton.disabled = false;
  } finally {
    confirmStudentCsvImportButton.removeAttribute("aria-busy");
  }
});
document.getElementById("addStudentGuardianButton").addEventListener("click", () => createStudentGuardianRow());
document.getElementById("cancelStudentRecordButton").addEventListener("click", resetStudentRecordForm);
document.getElementById("closeStudentRecordModalButton").addEventListener("click", resetStudentRecordForm);
studentRecordModal.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    resetStudentRecordForm();
  }
});
studentRecordModal.addEventListener("click", (event) => {
  if (event.target === studentRecordModal) resetStudentRecordForm();
});
outboxStatusFilter.addEventListener("change", loadOutbox);
refreshOutboxButton.addEventListener("click", loadOutbox);
integrationBatchSearch.addEventListener("input", renderIntegrationBatches);
integrationBatchStatusFilter.addEventListener("change", renderIntegrationBatches);
refreshIntegrationBatchesButton.addEventListener("click", loadIntegrationBatches);
document.getElementById("cancelStaffEditButton").addEventListener("click", resetStaffAccountForm);
document.getElementById("closeStaffAccountModalButton").addEventListener("click", resetStaffAccountForm);
document.getElementById("cancelStaffPasswordButton").addEventListener("click", closeStaffPasswordModal);
document.getElementById("closeStaffPasswordModalButton").addEventListener("click", closeStaffPasswordModal);
staffPasswordModal.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeStaffPasswordModal();
  }
});
staffPasswordModal.addEventListener("click", (event) => {
  if (event.target === staffPasswordModal) closeStaffPasswordModal();
});
staffAccountModal.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    resetStaffAccountForm();
  }
});
staffAccountModal.addEventListener("click", (event) => {
  if (event.target === staffAccountModal) resetStaffAccountForm();
});
staffAccountModal.addEventListener("close", () => {
  document.querySelector("[data-staff-add]").setAttribute("aria-expanded", "false");
  if (editingStaffAccountId) resetStaffAccountForm();
});
staffAccountSearch.addEventListener("input", renderStaffAccounts);
staffRoleFilter.addEventListener("change", renderStaffAccounts);
refreshStaffAccountsButton.addEventListener("click", loadStaffAccounts);
document.querySelector("[data-staff-add]").addEventListener("click", () => {
  openNewStaffAccountForm();
});
document.getElementById("refreshReadinessButton").addEventListener("click", loadDashboardReadiness);
document.getElementById("reportClassFilter").addEventListener("change", renderResultsReport);
document.getElementById("reportSubjectFilter").addEventListener("change", renderResultsReport);
document.getElementById("reportTermFilter").addEventListener("change", renderResultsReport);
document.getElementById("reportYearFilter").addEventListener("change", renderResultsReport);
document.getElementById("refreshResultsReportButton").addEventListener("click", loadResultsReport);
document.getElementById("exportResultsReportButton").addEventListener("click", exportResultsReport);
document.getElementById("printResultsReportButton").addEventListener("click", printResultsReport);

studentRecordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const saveButton = document.getElementById("saveStudentRecordButton");
  saveButton.disabled = true;
  const isEditing = Boolean(editingStudentId);
  const url = isEditing
    ? `/api/students/${encodeURIComponent(editingStudentId)}`
    : "/api/students";
  try {
    const response = await requestJson(url, {
      method: isEditing ? "PUT" : "POST",
      body: JSON.stringify(buildStudentRecordPayload()),
    });
    selectedStudentId = String(response.data.studentId);
    studentsLoaded = true;
    resetStudentRecordForm();
    const admissionMessage = response.data?.admissionNumber
      ? ` Admission number: ${response.data.admissionNumber}.`
      : "";
    showAppMessage(`${response.message || "Learner record saved."}${admissionMessage}`);
    await loadStudents();
  } catch (error) {
    showAppMessage(error.message, true);
  } finally {
    saveButton.disabled = false;
  }
});

staffAccountForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const saveButton = document.getElementById("saveStaffAccountButton");
  saveButton.disabled = true;
  const payload = {
    name: document.getElementById("staffNameInput").value.trim(),
    email: document.getElementById("staffEmailInput").value.trim(),
    role: document.getElementById("staffRoleInput").value,
    password: document.getElementById("staffPasswordInput").value,
  };

  try {
    const response = await requestJson(
      editingStaffAccountId ? `/api/admin/users/${encodeURIComponent(editingStaffAccountId)}` : "/api/admin/users",
      {
        method: editingStaffAccountId ? "PUT" : "POST",
        body: JSON.stringify(payload),
      }
    );
    showAppMessage(response.message || "Staff account saved.");
    resetStaffAccountForm();
    await loadStaffAccounts();
  } catch (error) {
    showAppMessage(error.message, true);
  } finally {
    saveButton.disabled = false;
  }
});

staffAccountTableBody.addEventListener("click", async (event) => {
  const resetPasswordButton = event.target.closest("[data-reset-staff-password]");
  if (resetPasswordButton) {
    openStaffPasswordModal(resetPasswordButton.dataset.resetStaffPassword);
    return;
  }

  const editButton = event.target.closest("[data-edit-staff]");
  if (editButton) {
    editStaffAccount(editButton.dataset.editStaff);
    return;
  }

  const deleteButton = event.target.closest("[data-delete-staff]");
  if (!deleteButton || deleteButton.disabled) return;
  const account = staffAccounts.find((entry) => String(entry.id) === String(deleteButton.dataset.deleteStaff));
  if (!account || !window.confirm(`Delete the staff account for ${account.name}? They will no longer be able to sign in.`)) return;

  deleteButton.disabled = true;
  try {
    const response = await requestJson(`/api/admin/users/${encodeURIComponent(account.id)}`, { method: "DELETE" });
    showAppMessage(response.message || "Staff account deleted.");
    if (editingStaffAccountId === String(account.id)) resetStaffAccountForm();
    await loadStaffAccounts();
  } catch (error) {
    showAppMessage(error.message, true);
    deleteButton.disabled = false;
  }
});

outboxTableBody.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-retry-sms]");
  if (!button) return;

  button.disabled = true;
  try {
    const response = await requestJson(`/api/sms/outbox/${encodeURIComponent(button.dataset.retrySms)}/retry`, {
      method: "POST",
    });
    showAppMessage(response.message || "SMS queued for retry.");
    await loadOutbox();
  } catch (error) {
    showAppMessage(error.message, true);
    button.disabled = false;
  }
});

integrationBatchTableBody.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-queue-batch-sms]");
  if (!button || button.disabled) return;

  const batch = integrationBatches.find(
    (entry) => String(entry.id) === String(button.dataset.queueBatchSms)
  );
  if (!batch || !window.confirm(
    `Queue result SMS for active, valid guardian contacts for ${batch.examName} (${batch.term} ${batch.year})? Existing batch/guardian messages will not be duplicated.`
  )) {
    return;
  }

  button.disabled = true;
  try {
    const response = await requestJson(
      `/api/integrations/batches/${encodeURIComponent(batch.id)}/queue-sms`,
      { method: "POST" }
    );
    showAppMessage(response.message || "SMS queued for this results batch.");
    await loadIntegrationBatches();
  } catch (error) {
    showAppMessage(error.message, true);
    button.disabled = false;
  }
});

studentList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-student-id]");
  if (button) loadSelectedStudent(button.dataset.studentId);
});

restoreSession();
