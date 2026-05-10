/**
 * RHSMART AXIS — API Client (frontend)
 * Remplace toutes les fonctions simulées du HTML d'origine
 * 
 * Ajoutez ce script dans votre HTML :
 * <script src="api-client.js"></script>
 * 
 * Configuration :
 * Changez BACKEND_URL pour pointer vers votre serveur déployé
 */

// ─── CONFIG ────────────────────────────────────────────────────────────────
const BACKEND_URL = window.location.hostname === 'localhost'
  ? 'https://rhsmart-axis-1.onrender.com'
  : 'https://api.rhsmart-axis.com';  // ← Remplacez par votre domaine

// ─── STATE ─────────────────────────────────────────────────────────────────
let authToken = localStorage.getItem('rhsmart_token');
let currentUser = JSON.parse(localStorage.getItem('rhsmart_user') || 'null');

// ─── HTTP CLIENT ───────────────────────────────────────────────────────────
async function api(method, path, body = null, isFormData = false) {
  const headers = {};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (!isFormData) headers['Content-Type'] = 'application/json';

  const options = { method, headers };
  if (body) options.body = isFormData ? body : JSON.stringify(body);

  try {
    const res = await fetch(`${BACKEND_URL}${path}`, options);

    if (res.status === 401) {
      logout();
      return null;
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
    return data;
  } catch (err) {
    console.error(`API Error [${method} ${path}]:`, err);
    showToast('⚠️ ' + err.message, 'var(--danger)');
    return null;
  }
}

const GET  = (path)          => api('GET',    path);
const POST = (path, body)    => api('POST',   path, body);
const PUT  = (path, body)    => api('PUT',    path, body);
const DEL  = (path)          => api('DELETE', path);

// ═══════════════════════════════════════════════════════════════════
// 🔐 AUTH
// ═══════════════════════════════════════════════════════════════════

async function login(email, password) {
  const data = await POST('/auth/login', { email, password });
  if (!data) return;

  authToken = data.token;
  currentUser = data.user;
  localStorage.setItem('rhsmart_token', authToken);
  localStorage.setItem('rhsmart_user', JSON.stringify(currentUser));

  // Cacher l'écran de login, afficher l'app
  document.getElementById('login-screen')?.remove();
  document.getElementById('app').style.display = 'flex';

  // Mettre à jour l'UI avec le nom de l'utilisateur
  updateUserCard();
  loadDashboard();
}

function logout() {
  POST('/auth/logout');
  authToken = null;
  currentUser = null;
  localStorage.removeItem('rhsmart_token');
  localStorage.removeItem('rhsmart_user');
  window.location.reload();
}

function updateUserCard() {
  if (!currentUser) return;
  const initials = (currentUser.email || 'AD').substring(0, 2).toUpperCase();
  const roleLabels = { admin: 'Super Admin', drh: 'DRH', manager: 'Manager', employe: 'Employé' };
  document.querySelector('.avatar').textContent = initials;
  document.querySelector('.user-info h4').textContent = currentUser.email;
  document.querySelector('.user-info span').textContent = roleLabels[currentUser.role] || currentUser.role;
}

// ═══════════════════════════════════════════════════════════════════
// 📊 DASHBOARD
// ═══════════════════════════════════════════════════════════════════

async function loadDashboard() {
  const [stats, activites, depts] = await Promise.all([
    GET('/dashboard/stats'),
    GET('/dashboard/activites'),
    GET('/dashboard/departements'),
  ]);

  if (stats) {
    document.querySelector('.stat-card:nth-child(1) .stat-value').textContent = stats.employes_actifs;
    document.querySelector('.stat-card:nth-child(2) .stat-value').textContent = stats.conges_en_attente;
    document.querySelector('.stat-card:nth-child(3) .stat-value').textContent = stats.evaluations_en_cours;

    // Badge sidebar congés
    const badge = document.querySelector('[onclick*="conges"] .nav-badge');
    if (badge) badge.textContent = stats.conges_en_attente;
  }

  if (activites) renderActivites(activites);
  if (depts)     renderDepartements(depts);
}

function renderActivites(activites) {
  const container = document.querySelector('#page-dashboard .card:first-child');
  if (!container) return;
  const icons = { employe_cree: '👤', conge_decision: '🌴', carriere_event: '📈', default: '📋' };
  const html = activites.map(a => `
    <div class="notif">
      <div class="notif-icon">${icons[a.type] || icons.default}</div>
      <div>
        <div class="notif-text">${escapeHtml(a.description)}</div>
        <div class="notif-time">${timeAgo(a.created_at)}</div>
      </div>
    </div>`).join('');
  container.querySelector('.card-title').insertAdjacentHTML('afterend', html);
}

function renderDepartements(depts) {
  const total = depts.reduce((s, d) => s + d.effectif, 0);
  const container = document.querySelector('#page-dashboard .card:last-child');
  if (!container) return;
  const colors = ['var(--accent)', 'var(--accent2)', 'var(--accent3)', 'var(--success)', 'var(--danger)'];
  const html = depts.map((d, i) => `
    <div>
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px;">
        <span>${escapeHtml(d.departement)}</span>
        <span style="color:${colors[i % colors.length]}">${d.effectif}</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${Math.round(d.effectif/total*100)}%"></div></div>
    </div>`).join('');
  container.querySelector('.card-title').insertAdjacentHTML('afterend', html);
}

// ═══════════════════════════════════════════════════════════════════
// 👥 EMPLOYÉS
// ═══════════════════════════════════════════════════════════════════

async function loadEmployes(filters = {}) {
  const params = new URLSearchParams(filters).toString();
  const data = await GET(`/employes?${params}`);
  if (!data) return;

  const tbody = document.getElementById('emp-table-body');
  if (!tbody) return;

  tbody.innerHTML = data.data.map(emp => `
    <tr>
      <td>
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,#00d4aa,#3b82f6);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;">
            ${emp.prenom[0]}${emp.nom[0]}
          </div>
          <div>
            <div style="font-weight:500">${escapeHtml(emp.prenom)} ${escapeHtml(emp.nom)}</div>
            <div style="font-size:11px;color:var(--text3)">${emp.matricule}</div>
          </div>
        </div>
      </td>
      <td>${escapeHtml(emp.poste)}</td>
      <td><span class="badge badge-blue">${escapeHtml(emp.departement)}</span></td>
      <td>${formatDate(emp.date_embauche)}</td>
      <td><span class="badge ${emp.statut === 'actif' ? 'badge-green' : 'badge-yellow'}">● ${emp.statut}</span></td>
      <td><span style="color:var(--accent);font-weight:600">${emp.solde_conges}j</span></td>
      <td style="display:flex;gap:6px;">
        <button class="btn btn-ghost btn-sm" onclick="loadEmployeDetail('${emp.id}')">👁 Voir</button>
        <button class="btn btn-ghost btn-sm" onclick="showPage('carriere')">📈</button>
      </td>
    </tr>`).join('');
}

async function loadEmployeDetail(id) {
  const emp = await GET(`/employes/${id}`);
  if (!emp) return;

  // Mettre à jour l'en-tête
  document.getElementById('detail-avatar').textContent = `${emp.prenom[0]}${emp.nom[0]}`;
  document.getElementById('detail-name').textContent = `${emp.prenom} ${emp.nom}`;
  document.getElementById('detail-poste').textContent = `${emp.poste} — ${emp.departement}`;

  // Onglet infos
  const infosContainer = document.getElementById('tab-infos');
  if (infosContainer) {
    infosContainer.innerHTML = `
      <div class="grid-2">
        <div class="card">
          <div class="card-title">👤 Informations personnelles</div>
          <div style="display:flex;flex-direction:column;gap:10px;font-size:13.5px;">
            ${infoRow('Nom complet', `${emp.prenom} ${emp.nom}`)}
            ${infoRow('Date naissance', emp.date_naissance ? formatDate(emp.date_naissance) : '—')}
            ${infoRow('N° CNI', emp.numero_cni || '—')}
            ${infoRow('Téléphone', emp.telephone || '—')}
            ${infoRow('Email', emp.email || '—')}
          </div>
        </div>
        <div class="card">
          <div class="card-title">💼 Informations professionnelles</div>
          <div style="display:flex;flex-direction:column;gap:10px;font-size:13.5px;">
            ${infoRow('Poste', emp.poste)}
            ${infoRow('Département', emp.departement)}
            ${infoRow('Contrat', emp.type_contrat)}
            ${infoRow('Salaire brut', `${Number(emp.salaire_brut).toLocaleString('fr-FR')} FCFA`)}
            ${infoRow('Congés restants', `<span style="color:var(--accent);font-weight:600">${emp.solde_conges} jours</span>`)}
          </div>
        </div>
      </div>`;
  }

  // Stocker l'ID courant
  window._currentEmployeId = id;
  showPage('employe-detail');
}

async function addEmployee() {
  const form = document.getElementById('form-add-employe');
  if (!form) return;

  const payload = {
    nom:          document.getElementById('add-nom')?.value,
    prenom:       document.getElementById('add-prenom')?.value,
    email:        document.getElementById('add-email')?.value,
    poste:        document.getElementById('add-poste')?.value,
    departement:  document.getElementById('add-dept')?.value,
    date_embauche: document.getElementById('add-date')?.value,
    salaire_brut: Number(document.getElementById('add-salaire')?.value),
    type_contrat: document.getElementById('add-contrat')?.value,
  };

  if (!payload.nom || !payload.prenom || !payload.poste) {
    showToast('⚠️ Remplissez tous les champs obligatoires', 'var(--danger)');
    return;
  }

  const data = await POST('/employes', payload);
  if (data) {
    closeModal('addEmploye');
    showToast(`✅ ${data.prenom} ${data.nom} ajouté(e) avec le matricule ${data.matricule}`);
    loadEmployes();
  }
}

// ═══════════════════════════════════════════════════════════════════
// 🌴 CONGÉS — Remplace approveLeave / rejectLeave / submitLeave
// ═══════════════════════════════════════════════════════════════════

async function loadConges() {
  const data = await GET('/conges?statut=en_attente');
  if (!data) return;
  renderCongesTable(data);
}

async function approveLeave(btn, congeId) {
  const data = await PUT(`/conges/${congeId}/decision`, { decision: 'approuve' });
  if (data) {
    const card = btn.closest('div[style*="border-radius"]');
    card.querySelector('.badge').className = 'badge badge-green';
    card.querySelector('.badge').textContent = '✅ Approuvé';
    btn.closest('div[style*="display:flex"]').innerHTML = '<span style="color:var(--success);font-size:13px;">✅ Congé approuvé</span>';
    showToast('✅ Congé approuvé — solde mis à jour en base');
    loadDashboard();
  }
}

async function rejectLeave(btn, congeId) {
  const data = await PUT(`/conges/${congeId}/decision`, { decision: 'refuse' });
  if (data) {
    const card = btn.closest('div[style*="border-radius"]');
    card.querySelector('.badge').className = 'badge badge-red';
    card.querySelector('.badge').textContent = '✕ Refusé';
    btn.closest('div[style*="display:flex"]').innerHTML = '<span style="color:var(--danger);font-size:13px;">✕ Congé refusé</span>';
    showToast('Congé refusé et enregistré.', 'var(--danger)');
  }
}

async function submitLeave() {
  const employe_id = currentUser?.employeeId;
  const payload = {
    employe_id,
    type_conge:  document.getElementById('leave-type')?.value || 'annuel',
    date_debut:  document.getElementById('leave-debut')?.value,
    date_fin:    document.getElementById('leave-fin')?.value,
    motif:       document.getElementById('leave-motif')?.value,
  };

  if (!payload.date_debut || !payload.date_fin) {
    showToast('⚠️ Sélectionnez les dates de congé', 'var(--danger)');
    return;
  }

  const data = await POST('/conges', payload);
  if (data) {
    closeModal('addConge');
    showToast(`🌴 Demande soumise (${data.nb_jours} jour(s)) — en attente d'approbation`, 'var(--accent3)');
  }
}

// ═══════════════════════════════════════════════════════════════════
// 💰 BULLETINS — Remplace exportPDF / sendWhatsApp
// ═══════════════════════════════════════════════════════════════════

async function calculerEtGenererBulletin(employe_id, nom) {
  const now = new Date();
  const data = await POST('/bulletins/calculer', {
    employe_id,
    mois: now.getMonth() + 1,
    annee: now.getFullYear(),
  });
  if (data) {
    showToast(`💰 Bulletin calculé — Net: ${Number(data.salaire_net).toLocaleString('fr-FR')} FCFA`);
    window._lastBulletinId = data.id;
  }
  return data;
}

async function exportPDF(employe_id, nom) {
  // Calculer d'abord, puis télécharger
  const bulletin = await calculerEtGenererBulletin(employe_id, nom);
  if (!bulletin) return;

  // Téléchargement direct du PDF
  const a = document.createElement('a');
  a.href = `${BACKEND_URL}/bulletins/${bulletin.id}/pdf`;
  a.download = `bulletin_${nom}_${bulletin.mois}_${bulletin.annee}.pdf`;
  document.head.append(a);

  // Ajouter le header auth via fetch + blob
  const res = await fetch(a.href, { headers: { Authorization: `Bearer ${authToken}` } });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.click();
  URL.revokeObjectURL(url);
  a.remove();

  showToast(`📄 Bulletin PDF de ${nom} téléchargé !`);
}

async function sendWhatsApp(bulletinId, nom) {
  const data = await POST(`/bulletins/${bulletinId}/whatsapp`, {});
  if (data) showToast(`📱 Bulletin envoyé via WhatsApp à ${nom} !`, '#25d366');
}

async function exportAllPDF() {
  showToast('📄 Génération des bulletins en cours...', 'var(--accent2)');
  // En production : endpoint batch côté serveur
  const employes = await GET('/employes?limit=100');
  if (!employes) return;

  let count = 0;
  for (const emp of employes.data) {
    await calculerEtGenererBulletin(emp.id, `${emp.prenom} ${emp.nom}`);
    count++;
  }
  showToast(`✅ ${count} bulletins générés !`);
}

async function sendAllWA() {
  showToast('📱 Envoi WhatsApp groupé en cours...', '#25d366');
  // Appel endpoint batch
}

// ═══════════════════════════════════════════════════════════════════
// 📎 DOCUMENTS — Remplace simulateUpload
// ═══════════════════════════════════════════════════════════════════

function initUploadZone() {
  const zone = document.querySelector('.upload-zone');
  if (!zone) return;

  // Créer un input file caché
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.pdf,.jpg,.jpeg,.png,.doc,.docx';
  input.style.display = 'none';
  document.body.appendChild(input);

  zone.onclick = () => input.click();
  zone.ondragover = (e) => { e.preventDefault(); zone.style.borderColor = 'var(--accent)'; };
  zone.ondrop = (e) => {
    e.preventDefault();
    zone.style.borderColor = '';
    uploadDocument(e.dataTransfer.files[0]);
  };

  input.onchange = () => {
    if (input.files[0]) uploadDocument(input.files[0]);
  };
}

async function uploadDocument(file) {
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    showToast('⚠️ Fichier trop grand (max 10 MB)', 'var(--danger)');
    return;
  }

  const employe_id = window._currentEmployeId;
  if (!employe_id) { showToast('⚠️ Aucun employé sélectionné', 'var(--danger)'); return; }

  showToast('📎 Upload en cours...', 'var(--accent2)');

  const formData = new FormData();
  formData.append('file', file);
  formData.append('nom', file.name);
  formData.append('type', detectDocType(file.name));

  const data = await api('POST', `/employes/${employe_id}/documents`, formData, true);
  if (data) {
    showToast('📎 Document uploadé avec succès !');

    // Ajouter à la liste sans recharger
    const filesList = document.getElementById('files-list');
    if (filesList) {
      const icon = { pdf: '📄', jpg: '🖼️', jpeg: '🖼️', png: '🖼️', doc: '📝', docx: '📝' };
      const ext = file.name.split('.').pop().toLowerCase();
      filesList.insertAdjacentHTML('beforeend', `
        <div class="file-item">
          <span class="file-icon">${icon[ext] || '📄'}</span>
          <span class="file-name">${escapeHtml(data.nom)}</span>
          <span class="file-size">${formatFileSize(data.taille)}</span>
          <a href="${data.url}" target="_blank" class="btn btn-ghost btn-sm" style="margin-left:auto">⬇️</a>
        </div>`);
    }
  }
}

function detectDocType(filename) {
  const lower = filename.toLowerCase();
  if (lower.includes('contrat')) return 'contrat';
  if (lower.includes('diplome') || lower.includes('diplôme')) return 'diplome';
  if (lower.includes('cni') || lower.includes('identit')) return 'cni';
  return 'autre';
}

// ═══════════════════════════════════════════════════════════════════
// 🤖 IA — Proxy sécurisé (remplace l'appel direct Anthropic)
// ═══════════════════════════════════════════════════════════════════

async function sendMessageText(text) {
  addMessage('user', text);
  aiHistory.push({ role: 'user', content: text });
  showTyping();

  try {
    const data = await POST('/ia/chat', { messages: aiHistory });
    removeTyping();

    if (!data) {
      addMessage('bot', '⚠️ Service IA temporairement indisponible.');
      return;
    }

    const formatted = data.reply
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/\n\n/g, '<br><br>')
      .replace(/\n/g, '<br>');

    addMessage('bot', formatted);
    aiHistory.push({ role: 'assistant', content: data.reply });
  } catch (e) {
    removeTyping();
    addMessage('bot', '⚠️ Impossible de joindre l\'assistant IA.');
  }
}

// ═══════════════════════════════════════════════════════════════════
// 🛠️ UTILITAIRES
// ═══════════════════════════════════════════════════════════════════

function infoRow(label, value) {
  return `<div style="display:flex;justify-content:space-between;"><span style="color:var(--text2)">${label}</span><span>${value}</span></div>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('fr-FR');
}

function formatFileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 60) return `Il y a ${min}min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `Il y a ${h}h`;
  return `Il y a ${Math.floor(h / 24)}j`;
}

// ─── INIT ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (authToken) {
    updateUserCard();
    loadDashboard();
    initUploadZone();
  } else {
    showLoginScreen();
  }
});

function showLoginScreen() {
  document.body.insertAdjacentHTML('beforeend', `
    <div id="login-screen" style="
      position:fixed;inset:0;background:var(--bg);
      display:flex;align-items:center;justify-content:center;z-index:9999;">
      <div style="background:var(--surface);border:1px solid var(--border);
                  border-radius:20px;padding:40px;width:380px;max-width:95vw;">
        <div style="text-align:center;margin-bottom:32px;">
          <div style="width:56px;height:56px;border-radius:16px;
            background:linear-gradient(135deg,var(--accent),var(--accent2));
            display:flex;align-items:center;justify-content:center;
            font-size:24px;font-weight:800;color:#fff;
            font-family:'Syne',sans-serif;margin:0 auto 12px;">RH</div>
          <h1 style="font-family:'Syne',sans-serif;font-size:20px;font-weight:800;">RHSMART AXIS</h1>
          <p style="font-size:12px;color:var(--text3);margin-top:4px;">Connexion à votre espace RH</p>
        </div>
        <div class="form-group">
          <label class="form-label">Email</label>
          <input class="form-input" id="login-email" type="email" placeholder="admin@corp.bj">
        </div>
        <div class="form-group">
          <label class="form-label">Mot de passe</label>
          <input class="form-input" id="login-password" type="password" placeholder="••••••••"
            onkeydown="if(event.key==='Enter') doLogin()">
        </div>
        <button class="btn btn-primary" style="width:100%;padding:12px;"
          onclick="doLogin()">Se connecter →</button>
        <p id="login-error" style="color:var(--danger);font-size:12px;text-align:center;margin-top:12px;display:none;"></p>
      </div>
    </div>`);
}

async function doLogin() {
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl    = document.getElementById('login-error');

  if (!email || !password) {
    errEl.textContent = 'Remplissez tous les champs';
    errEl.style.display = 'block';
    return;
  }

  errEl.style.display = 'none';
  await login(email, password);
}
