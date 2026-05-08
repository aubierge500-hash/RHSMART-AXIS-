/**
 * RHSMART AXIS — Backend Proxy Server
 * Node.js + Express + Supabase
 * 
 * Rôles :
 *  1. Proxy sécurisé vers l'API Anthropic (clé cachée côté serveur)
 *  2. Auth JWT via Supabase
 *  3. CRUD Employés, Congés, Évaluations, Carrière, Documents
 *  4. Génération PDF bulletins de paie
 *  5. Upload fichiers vers Supabase Storage
 *  6. Notifications WhatsApp (Meta Business API)
 */

require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const Anthropic    = require('@anthropic-ai/sdk');
const multer       = require('multer');
const PDFDocument  = require('pdfkit');
const axios        = require('axios');
const path         = require('path');

const app = express();

// ─── SUPABASE CLIENT (service role — côté serveur uniquement) ──────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY   // JAMAIS exposé au frontend
);

// ─── ANTHROPIC CLIENT ──────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── MIDDLEWARES ───────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// Rate limiting global
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 min
  max: 200,
  message: { error: 'Trop de requêtes, réessayez dans 15 minutes.' },
}));

// Rate limiting spécifique IA (plus restrictif)
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 min
  max: 20,
  message: { error: 'Limite IA atteinte, attendez 1 minute.' },
});

// ─── MIDDLEWARE AUTH ────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token manquant' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Token invalide' });

  req.user = user;
  next();
}

// ─── MIDDLEWARE RÔLE ────────────────────────────────────────────────────────
async function requireRole(...roles) {
  return async (req, res, next) => {
    const { data, error } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', req.user.id)
      .single();

    if (error || !roles.includes(data?.role)) {
      return res.status(403).json({ error: 'Accès refusé — rôle insuffisant' });
    }
    req.userRole = data.role;
    next();
  };
}

// Upload en mémoire (puis vers Supabase Storage)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ═══════════════════════════════════════════════════════════════════
// 🔐 AUTH
// ═══════════════════════════════════════════════════════════════════

// Connexion
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: 'Identifiants incorrects' });

  // Récupérer le rôle
  const { data: roleData } = await supabase
    .from('user_roles')
    .select('role, employee_id')
    .eq('user_id', data.user.id)
    .single();

  res.json({
    token: data.session.access_token,
    user: {
      id: data.user.id,
      email: data.user.email,
      role: roleData?.role || 'employe',
      employeeId: roleData?.employee_id,
    }
  });
});

// Déconnexion
app.post('/auth/logout', requireAuth, async (req, res) => {
  await supabase.auth.signOut();
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════
// 👥 EMPLOYÉS
// ═══════════════════════════════════════════════════════════════════

// Lister tous les employés
app.get('/employes', requireAuth, async (req, res) => {
  const { departement, statut, search, page = 1, limit = 20 } = req.query;

  let query = supabase
    .from('employes')
    .select(`
      id, matricule, nom, prenom, poste, departement, date_embauche,
      statut, solde_conges, photo_url,
      conges_pris:conges(count)
    `)
    .order('nom');

  if (departement) query = query.eq('departement', departement);
  if (statut)      query = query.eq('statut', statut);
  if (search)      query = query.ilike('nom', `%${search}%`);

  const from = (page - 1) * limit;
  query = query.range(from, from + limit - 1);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.json({ data, total: count, page: +page, limit: +limit });
});

// Détail d'un employé
app.get('/employes/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('employes')
    .select(`
      *,
      carriere:historique_carriere(* order by date desc),
      evaluations:evaluations(* order by date desc),
      conges:conges(* order by date_debut desc),
      documents:documents(id, nom, type, taille, url, created_at)
    `)
    .eq('id', req.params.id)
    .single();

  if (error) return res.status(404).json({ error: 'Employé introuvable' });
  res.json(data);
});

// Créer un employé
app.post('/employes', requireAuth, requireRole('drh', 'admin'), async (req, res) => {
  const { nom, prenom, email, poste, departement, date_embauche, salaire_brut, type_contrat } = req.body;

  // Validation basique
  if (!nom || !prenom || !poste || !departement) {
    return res.status(400).json({ error: 'Champs obligatoires manquants' });
  }

  // Générer un matricule unique
  const { count } = await supabase.from('employes').select('id', { count: 'exact' });
  const matricule = `EMP-${String((count || 0) + 1).padStart(3, '0')}`;

  const { data, error } = await supabase
    .from('employes')
    .insert({
      nom, prenom, email, poste, departement, date_embauche,
      salaire_brut, type_contrat, matricule,
      statut: 'actif',
      solde_conges: 30,  // quota annuel par défaut (droit béninois)
      created_by: req.user.id,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Log activité
  await logActivite('employe_cree', `Nouvel employé : ${prenom} ${nom}`, req.user.id);

  res.status(201).json(data);
});

// Modifier un employé
app.put('/employes/:id', requireAuth, requireRole('drh', 'admin'), async (req, res) => {
  const { data, error } = await supabase
    .from('employes')
    .update({ ...req.body, updated_at: new Date() })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ═══════════════════════════════════════════════════════════════════
// 📈 HISTORIQUE CARRIÈRE
// ═══════════════════════════════════════════════════════════════════

app.get('/employes/:id/carriere', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('historique_carriere')
    .select('*')
    .eq('employe_id', req.params.id)
    .order('date', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/employes/:id/carriere', requireAuth, requireRole('drh', 'admin'), async (req, res) => {
  const { type_evenement, description, date, ancien_poste, nouveau_poste } = req.body;

  const { data, error } = await supabase
    .from('historique_carriere')
    .insert({
      employe_id: req.params.id,
      type_evenement, description, date,
      ancien_poste, nouveau_poste,
      created_by: req.user.id,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  await logActivite('carriere_event', `${type_evenement} — employé ${req.params.id}`, req.user.id);
  res.status(201).json(data);
});

// ═══════════════════════════════════════════════════════════════════
// ⭐ ÉVALUATIONS
// ═══════════════════════════════════════════════════════════════════

app.get('/evaluations', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('evaluations')
    .select(`*, employe:employes(nom, prenom, poste, departement)`)
    .order('date', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/evaluations', requireAuth, requireRole('drh', 'manager', 'admin'), async (req, res) => {
  const { employe_id, periode, note_globale, note_objectifs, note_comportement, commentaire, objectifs_suivant } = req.body;

  const { data, error } = await supabase
    .from('evaluations')
    .insert({
      employe_id, periode, note_globale, note_objectifs,
      note_comportement, commentaire, objectifs_suivant,
      evaluateur_id: req.user.id,
      date: new Date(),
      statut: 'complétée',
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// ═══════════════════════════════════════════════════════════════════
// 🌴 CONGÉS
// ═══════════════════════════════════════════════════════════════════

// Lister les demandes
app.get('/conges', requireAuth, async (req, res) => {
  const { statut } = req.query;
  let query = supabase
    .from('conges')
    .select(`*, employe:employes(nom, prenom, poste, departement, solde_conges)`)
    .order('created_at', { ascending: false });

  // Un employé ne voit que les siens
  if (req.userRole === 'employe') {
    const { data: empData } = await supabase
      .from('user_roles')
      .select('employee_id')
      .eq('user_id', req.user.id)
      .single();
    query = query.eq('employe_id', empData?.employee_id);
  }

  if (statut) query = query.eq('statut', statut);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Soumettre une demande
app.post('/conges', requireAuth, async (req, res) => {
  const { employe_id, type_conge, date_debut, date_fin, motif } = req.body;

  // Calcul du nombre de jours ouvrés
  const jours = calculerJoursOuvres(new Date(date_debut), new Date(date_fin));

  // Vérifier le solde disponible
  const { data: emp } = await supabase
    .from('employes')
    .select('solde_conges')
    .eq('id', employe_id)
    .single();

  if (type_conge === 'annuel' && emp.solde_conges < jours) {
    return res.status(400).json({ error: `Solde insuffisant (${emp.solde_conges}j disponibles, ${jours}j demandés)` });
  }

  const { data, error } = await supabase
    .from('conges')
    .insert({
      employe_id, type_conge, date_debut, date_fin, motif,
      nb_jours: jours,
      statut: 'en_attente',
      created_by: req.user.id,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// Approuver ou refuser
app.put('/conges/:id/decision', requireAuth, requireRole('drh', 'manager', 'admin'), async (req, res) => {
  const { decision, commentaire } = req.body;  // 'approuve' | 'refuse'

  const { data: conge } = await supabase
    .from('conges')
    .select('*, employe:employes(solde_conges)')
    .eq('id', req.params.id)
    .single();

  // Si approuvé, déduire du solde
  if (decision === 'approuve' && conge.type_conge === 'annuel') {
    await supabase
      .from('employes')
      .update({ solde_conges: conge.employe.solde_conges - conge.nb_jours })
      .eq('id', conge.employe_id);
  }

  const { data, error } = await supabase
    .from('conges')
    .update({ statut: decision, commentaire_decision: commentaire, decide_par: req.user.id, decide_le: new Date() })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  await logActivite('conge_decision', `Congé ${decision} — ${conge.nb_jours}j`, req.user.id);
  res.json(data);
});

// ═══════════════════════════════════════════════════════════════════
// 💰 BULLETINS DE PAIE
// ═══════════════════════════════════════════════════════════════════

// Calcul d'un bulletin (moteur de paie béninois)
app.post('/bulletins/calculer', requireAuth, requireRole('drh', 'admin'), async (req, res) => {
  const { employe_id, mois, annee } = req.body;

  const { data: emp } = await supabase
    .from('employes')
    .select('*')
    .eq('id', employe_id)
    .single();

  if (!emp) return res.status(404).json({ error: 'Employé introuvable' });

  const bulletin = calculerBulletin(emp, mois, annee);

  // Sauvegarder le bulletin
  const { data, error } = await supabase
    .from('bulletins')
    .upsert({
      employe_id,
      mois, annee,
      salaire_brut: emp.salaire_brut,
      ...bulletin,
      genere_par: req.user.id,
      genere_le: new Date(),
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Générer le PDF d'un bulletin
app.get('/bulletins/:id/pdf', requireAuth, async (req, res) => {
  const { data: bulletin } = await supabase
    .from('bulletins')
    .select(`*, employe:employes(*)`)
    .eq('id', req.params.id)
    .single();

  if (!bulletin) return res.status(404).json({ error: 'Bulletin introuvable' });

  const pdfBuffer = await genererBulletinPDF(bulletin);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=bulletin_${bulletin.employe.matricule}_${bulletin.mois}_${bulletin.annee}.pdf`);
  res.send(pdfBuffer);
});

// Envoyer via WhatsApp
app.post('/bulletins/:id/whatsapp', requireAuth, requireRole('drh', 'admin'), async (req, res) => {
  const { data: bulletin } = await supabase
    .from('bulletins')
    .select(`*, employe:employes(nom, prenom, telephone)`)
    .eq('id', req.params.id)
    .single();

  if (!bulletin) return res.status(404).json({ error: 'Bulletin introuvable' });

  const pdfBuffer = await genererBulletinPDF(bulletin);

  // Upload temp vers Supabase Storage pour générer URL publique
  const filename = `bulletins/${bulletin.employe_id}_${bulletin.mois}_${bulletin.annee}.pdf`;
  await supabase.storage.from('bulletins').upload(filename, pdfBuffer, {
    contentType: 'application/pdf',
    upsert: true,
  });

  const { data: urlData } = supabase.storage.from('bulletins').getPublicUrl(filename);

  // Envoyer via WhatsApp Business API
  await envoyerWhatsApp(
    bulletin.employe.telephone,
    `Bonjour ${bulletin.employe.prenom},\n\nVotre bulletin de paie ${bulletin.mois}/${bulletin.annee} est disponible :\n${urlData.publicUrl}\n\nCordialement,\nRHSMART AXIS`
  );

  res.json({ success: true, message: `Bulletin envoyé à ${bulletin.employe.telephone}` });
});

// ═══════════════════════════════════════════════════════════════════
// 📎 DOCUMENTS / PIÈCES JOINTES
// ═══════════════════════════════════════════════════════════════════

app.post('/employes/:id/documents', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });

  const { nom, type } = req.body;
  const ext = path.extname(req.file.originalname);
  const filename = `employes/${req.params.id}/${Date.now()}${ext}`;

  // Upload vers Supabase Storage
  const { error: uploadError } = await supabase.storage
    .from('documents')
    .upload(filename, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false,
    });

  if (uploadError) return res.status(500).json({ error: 'Erreur upload: ' + uploadError.message });

  const { data: urlData } = supabase.storage.from('documents').getPublicUrl(filename);

  // Enregistrer en base
  const { data, error } = await supabase
    .from('documents')
    .insert({
      employe_id: req.params.id,
      nom: nom || req.file.originalname,
      type: type || 'autre',
      taille: req.file.size,
      url: urlData.publicUrl,
      storage_path: filename,
      uploaded_by: req.user.id,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

app.delete('/documents/:id', requireAuth, requireRole('drh', 'admin'), async (req, res) => {
  const { data: doc } = await supabase.from('documents').select('storage_path').eq('id', req.params.id).single();
  if (doc) await supabase.storage.from('documents').remove([doc.storage_path]);
  await supabase.from('documents').delete().eq('id', req.params.id);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════
// 🤖 IA ASSISTANT — PROXY SÉCURISÉ
// ═══════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT_RH = `Tu es un assistant RH expert intégré dans RHSMART AXIS, une application de gestion des ressources humaines utilisée au Bénin (Afrique de l'Ouest).

Tu aides les DRH, managers et employés avec :
- La rédaction de documents RH (lettres d'avertissement, sanctions, attestations, contrats)
- Le calcul et l'explication des congés, soldes, bulletins de paie (en FCFA)
- Les conseils sur les procédures disciplinaires selon le droit du travail béninois (Code du Travail Loi n°98-004)
- L'analyse des performances et objectifs
- Les meilleures pratiques RH pour les entreprises africaines
- La navigation dans les modules de RHSMART AXIS

Réponds toujours en français, de façon professionnelle mais accessible. Sois concis et pratique.`;

app.post('/ia/chat', requireAuth, aiLimiter, async (req, res) => {
  const { messages } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Messages requis' });
  }

  // Valider la taille de l'historique (max 20 messages)
  const history = messages.slice(-20);

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: SYSTEM_PROMPT_RH,
      messages: history,
    });

    res.json({ reply: response.content[0].text });
  } catch (err) {
    console.error('Anthropic API error:', err);
    res.status(500).json({ error: 'Service IA temporairement indisponible' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 📊 DASHBOARD — Statistiques
// ═══════════════════════════════════════════════════════════════════

app.get('/dashboard/stats', requireAuth, async (req, res) => {
  const [employes, congesPending, evaluations, bulletins] = await Promise.all([
    supabase.from('employes').select('statut', { count: 'exact' }).eq('statut', 'actif'),
    supabase.from('conges').select('id', { count: 'exact' }).eq('statut', 'en_attente'),
    supabase.from('evaluations').select('id', { count: 'exact' }).eq('statut', 'en_cours'),
    supabase.from('bulletins').select('id').eq('mois', new Date().getMonth() + 1).eq('annee', new Date().getFullYear()),
  ]);

  res.json({
    employes_actifs: employes.count,
    conges_en_attente: congesPending.count,
    evaluations_en_cours: evaluations.count,
    bulletins_ce_mois: bulletins.data?.length || 0,
  });
});

// Activités récentes
app.get('/dashboard/activites', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('activites')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Répartition par département
app.get('/dashboard/departements', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('employes')
    .select('departement')
    .eq('statut', 'actif');

  if (error) return res.status(500).json({ error: error.message });

  const counts = data.reduce((acc, e) => {
    acc[e.departement] = (acc[e.departement] || 0) + 1;
    return acc;
  }, {});

  res.json(Object.entries(counts).map(([dept, count]) => ({ departement: dept, effectif: count })));
});

// ═══════════════════════════════════════════════════════════════════
// 🛠️ FONCTIONS UTILITAIRES
// ═══════════════════════════════════════════════════════════════════

function calculerJoursOuvres(debut, fin) {
  let count = 0;
  const current = new Date(debut);
  while (current <= fin) {
    const day = current.getDay();
    if (day !== 0 && day !== 6) count++;
    current.setDate(current.getDate() + 1);
  }
  return count;
}

// Moteur de paie béninois simplifié
function calculerBulletin(employe, mois, annee) {
  const brut = employe.salaire_brut;

  // CNSS salarié : 3.6% (part employé)
  const cnss_salarie = Math.round(brut * 0.036);
  // CNSS patronal : 16.4% (charge entreprise)
  const cnss_patronal = Math.round(brut * 0.164);

  // Salaire soumis à ITS = Brut - CNSS salarié
  const salaire_its = brut - cnss_salarie;

  // ITS (Impôt sur Traitements et Salaires) — barème simplifié
  let its = 0;
  if (salaire_its <= 60000) its = 0;
  else if (salaire_its <= 130000) its = Math.round((salaire_its - 60000) * 0.10);
  else if (salaire_its <= 280000) its = 7000 + Math.round((salaire_its - 130000) * 0.15);
  else if (salaire_its <= 530000) its = 29500 + Math.round((salaire_its - 280000) * 0.19);
  else its = 77000 + Math.round((salaire_its - 530000) * 0.28);

  const net = brut - cnss_salarie - its;

  return {
    salaire_brut: brut,
    cnss_salarie,
    cnss_patronal,
    its,
    salaire_net: net,
    mois, annee,
  };
}

// Générer un PDF bulletin de paie
function genererBulletinPDF(bulletin) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];

    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const emp = bulletin.employe;
    const moisNoms = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];

    // En-tête
    doc.fontSize(18).font('Helvetica-Bold').text('RHSMART AXIS', 50, 50);
    doc.fontSize(10).font('Helvetica').fillColor('#666').text('Système de Gestion RH', 50, 75);

    doc.fontSize(14).font('Helvetica-Bold').fillColor('#000')
      .text(`BULLETIN DE PAIE — ${moisNoms[bulletin.mois - 1]} ${bulletin.annee}`, 50, 120);

    // Infos employé
    doc.fontSize(10).font('Helvetica')
      .text(`Nom : ${emp.prenom} ${emp.nom}`, 50, 160)
      .text(`Matricule : ${emp.matricule}`, 50, 178)
      .text(`Poste : ${emp.poste}`, 50, 196)
      .text(`Département : ${emp.departement}`, 50, 214);

    // Tableau de paie
    const tableY = 260;
    doc.fontSize(10).font('Helvetica-Bold')
      .text('LIBELLÉ', 50, tableY)
      .text('MONTANT (FCFA)', 400, tableY, { align: 'right', width: 145 });

    doc.moveTo(50, tableY + 16).lineTo(545, tableY + 16).stroke();

    const lignes = [
      ['Salaire de base brut', bulletin.salaire_brut],
      ['CNSS (part salariale 3.6%)', -bulletin.cnss_salarie],
      ['ITS (Impôt sur Traitements)', -bulletin.its],
    ];

    let y = tableY + 30;
    doc.font('Helvetica');
    lignes.forEach(([label, montant]) => {
      const color = montant < 0 ? '#c0392b' : '#000';
      doc.fillColor(color)
        .text(label, 50, y)
        .text(`${montant < 0 ? '-' : ''} ${Math.abs(montant).toLocaleString('fr-FR')} FCFA`, 400, y, { align: 'right', width: 145 });
      y += 20;
    });

    doc.moveTo(50, y + 5).lineTo(545, y + 5).stroke();

    doc.fontSize(12).font('Helvetica-Bold').fillColor('#006b5c')
      .text('SALAIRE NET À PAYER', 50, y + 15)
      .text(`${bulletin.salaire_net.toLocaleString('fr-FR')} FCFA`, 400, y + 15, { align: 'right', width: 145 });

    // Mention légale
    doc.fontSize(8).font('Helvetica').fillColor('#999')
      .text('Document généré par RHSMART AXIS. Confidentiel.', 50, 720);

    doc.end();
  });
}

// Logger une activité
async function logActivite(type, description, userId) {
  await supabase.from('activites').insert({ type, description, user_id: userId });
}

// Envoi WhatsApp via Meta Business API
async function envoyerWhatsApp(telephone, message) {
  if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_ID) {
    console.warn('WhatsApp non configuré — skipping');
    return;
  }

  await axios.post(
    `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: telephone.replace(/\D/g, ''),
      type: 'text',
      text: { body: message },
    },
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
  );
}

// ─── HEALTH CHECK ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));

// ─── 404 ───────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Route introuvable' }));

// ─── ERROR HANDLER ─────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Erreur serveur interne' });
});

// ─── START ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ RHSMART AXIS Backend démarré sur le port ${PORT}`);
});

module.exports = app;
