export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { action, key, id, payload } = req.body || {};

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Server config error' });
  }

  const headers = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  try {
    // action: 'select' — email完全一致でpayloadを取得
    if (action === 'select') {
      if (!key) return res.status(400).json({ error: 'key required' });
      const r = await fetch(
        `${supabaseUrl}/rest/v1/sf_user_data?email=eq.${encodeURIComponent(key)}&select=payload&limit=1`,
        { headers }
      );
      const data = await r.json();
      const found = Array.isArray(data) && data[0] && data[0].payload;
      return res.status(200).json({ payload: found || null });
    }

    // action: 'check_id' — IDプレフィックスで既存email確認
    if (action === 'check_id') {
      if (!id) return res.status(400).json({ error: 'id required' });
      const r = await fetch(
        `${supabaseUrl}/rest/v1/sf_user_data?email=ilike.${encodeURIComponent(id)}%3A*&select=email&limit=1`,
        { headers }
      );
      const data = await r.json();
      const existing = Array.isArray(data) && data[0] ? data[0].email : null;
      return res.status(200).json({ existing });
    }

    // action: 'upsert' — email + payloadを保存
    if (action === 'upsert') {
      if (!key || !payload) return res.status(400).json({ error: 'key and payload required' });
      const r = await fetch(`${supabaseUrl}/rest/v1/sf_user_data`, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ email: key, payload, updated_at: new Date().toISOString() }),
      });
      if (!r.ok) {
        const text = await r.text();
        console.error('[backup upsert]', r.status, text);
        return res.status(500).json({ error: 'upsert failed' });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'unknown action' });

  } catch (e) {
    console.error('[backup]', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
