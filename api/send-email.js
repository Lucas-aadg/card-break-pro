// Card Break Pro — Email sender via Resend
// Requires RESEND_API_KEY environment variable in Vercel.
// Sign up at resend.com, verify the hello@cardbreakpro.com domain, then add the key.

const FROM = 'Lucas from Card Break Pro <hello@cardbreakpro.com>';

async function sendEmail({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not configured in Vercel environment variables.');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: FROM, to, subject, html, text })
  });

  const data = await res.json();
  if (!res.ok) throw new Error('Resend error: ' + JSON.stringify(data));
  return data;
}

module.exports = { sendEmail, FROM };
