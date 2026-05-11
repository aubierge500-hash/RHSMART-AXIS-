const SUPABASE_U = 'https://uaspipsffvtbiydswqwt.supabase.co/rest/v1/';
const SUPABASE_KEY = 'sb_publishable_fop-_msYrKe-q7wEMkL-Hw_5RIg8EIo
';

async function login(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY
    },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (data.access_token) {
    alert('Connexion réussie !');
  } else {
    alert('Erreur: ' + (data.error_description || 'Connexion échouée'));
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.querySelector('button');
  if (btn) btn.addEventListener('click', (e) => {
    e.preventDefault();
    const email = document.querySelector('input[type=email]').value;
    const password = document.querySelector('input[type=password]').value;
    login(email, password);
  });
});
