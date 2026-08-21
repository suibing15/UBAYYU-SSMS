// Parent Portal full flow: login → verify student → load reports

window.addEventListener('DOMContentLoaded', () => {
  const authForm = document.getElementById('authFormParent');
  const authStatus = document.getElementById('authStatus');
  const studentCard = document.getElementById('studentCard');
  const authCard = document.getElementById('authCard');
  const verifyBtn = document.getElementById('verifyBtn');
  const studentInput = document.getElementById('studentIdInput');
  const statusDiv = document.getElementById('verifyStatus');

  // ---------------- LOGIN ----------------
  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const portalPassword = document.getElementById('portalPassword').value.trim();

    authStatus.textContent = 'Verifying...';
    authStatus.style.color = '#555';

    const res = await fetch('/api/portal/parent/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portalPassword })
    });

    const j = await res.json().catch(() => ({}));

    if (!res.ok || !j.success) {
      authStatus.style.color = 'red';
      authStatus.textContent = j.error || 'Invalid password. Please try again.';
      return;
    }

    authStatus.style.color = 'green';
    authStatus.textContent = 'Login successful!';
    setTimeout(() => {
      authCard.style.display = 'none';
      studentCard.style.display = 'block';
    }, 800);
  });

  // ---------------- VERIFY STUDENT ID ----------------
  verifyBtn.addEventListener('click', async () => {
    const studentId = studentInput.value.trim();
    if (!studentId) {
      statusDiv.style.color = 'red';
      statusDiv.textContent = 'Please enter a Student ID.';
      return;
    }

    statusDiv.textContent = 'Verifying Student ID...';
    statusDiv.style.color = '#555';

    const res = await fetch('/api/verify-student-id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentId })
    });

    const j = await res.json().catch(() => ({}));

    if (!res.ok || !j.valid) {
      statusDiv.style.color = 'red';
      statusDiv.textContent = j.error || 'Invalid Student ID.';
      return;
    }

    statusDiv.style.color = 'green';
    statusDiv.textContent = `Access granted for Student: ${j.student.name} (${j.student.id})`;

    await loadReports(studentId);
    document.getElementById('reportArea').style.display = 'block';
  });
});

// ---------------- LOAD REPORTS ----------------
async function loadReports(studentId) {
  const container = document.getElementById('reportList');
  container.innerHTML = '<p>Loading reports...</p>';

  const r = await fetch('/api/portal/parent/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studentId })
  });

  const j = await r.json().catch(() => ({}));

  if (!r.ok) {
    container.innerHTML = `<p style="color:red;">${j.error || 'Failed to load reports.'}</p>`;
    return;
  }

  container.innerHTML = `<h4>Reports for ${studentId}</h4>`;
  (j.pdfs || []).forEach(p => {
    const row = document.createElement('div');
    row.className = 'list-item';
    const left = document.createElement('div');
    left.textContent = `${p.type} ${p.subject || ''} ${p.examType ? '(' + p.examType + ')' : ''}`;
    const right = document.createElement('div');
    const link = document.createElement('a');
    link.href = p.filePath;
    link.target = "_blank";
    link.textContent = "Open PDF";
    right.appendChild(link);
    row.appendChild(left);
    row.appendChild(right);
    container.appendChild(row);
  });
}
