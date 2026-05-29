const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { user_id } = body;
  if (!user_id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing user_id' }) };
  }

  try {
    // Получаем все monitor id пользователя
    const { data: monitors } = await sb
      .from('monitors')
      .select('id')
      .eq('user_id', user_id);

    const monitorIds = (monitors || []).map(m => m.id);

    // Удаляем incidents
    if (monitorIds.length > 0) {
      await sb.from('incidents').delete().in('monitor_id', monitorIds);
    }

    // Удаляем responses
    if (monitorIds.length > 0) {
      await sb.from('responses').delete().in('monitor_id', monitorIds);
    }

    // Удаляем monitors
    await sb.from('monitors').delete().eq('user_id', user_id);

    // Удаляем запись users
    await sb.from('users').delete().eq('id', user_id);

    // Удаляем auth пользователя через admin API
    const { error: authError } = await sb.auth.admin.deleteUser(user_id);
    if (authError) {
      console.error('Auth delete error:', authError);
      // Не фатально — данные уже удалены
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('delete-account error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
