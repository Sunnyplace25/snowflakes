import crypto from 'crypto';

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  // Stripe署名検証
  try {
    const parts = sig.split(',');
    const timestamp = parts.find(p => p.startsWith('t=')).slice(2);
    const v1sigs = parts.filter(p => p.startsWith('v1=')).map(p => p.slice(3));
    const signedPayload = `${timestamp}.${rawBody}`;
    const expected = crypto.createHmac('sha256', webhookSecret).update(signedPayload).digest('hex');
    const valid = v1sigs.some(s => {
      try { return crypto.timingSafeEqual(Buffer.from(s, 'hex'), Buffer.from(expected, 'hex')); }
      catch { return false; }
    });
    if (!valid) return res.status(400).json({ error: 'Invalid signature' });
  } catch (e) {
    return res.status(400).json({ error: 'Signature verification failed' });
  }

  const event = JSON.parse(rawBody.toString());
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;
  const stripeKey = process.env.STRIPE_SECRET_KEY;

  const getCustomerEmail = async (customerId) => {
    const r = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
      headers: { 'Authorization': `Bearer ${stripeKey}` }
    });
    const c = await r.json();
    return c.email;
  };

  try {
    if (['customer.subscription.created', 'invoice.payment_succeeded'].includes(event.type)) {
      const customerId = event.data.object.customer;
      const email = await getCustomerEmail(customerId);
      if (email) {
        await fetch(`${supabaseUrl}/rest/v1/subscribers`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify({ email, stripe_customer_id: customerId, status: 'active' }),
        });
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const customerId = event.data.object.customer;
      const email = await getCustomerEmail(customerId);
      if (email) {
        await fetch(`${supabaseUrl}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
          },
          body: JSON.stringify({ status: 'cancelled' }),
        });
      }
    }
  } catch (e) {
    console.error('Supabase write error:', e);
  }

  res.status(200).json({ received: true });
}
