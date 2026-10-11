const { createClient } = require('@supabase/supabase-js');
const { getUserFromEvent } = require('../lib/auth');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // SECURITY: the user id comes from the verified login token, never from the request body.
  // Before this fix anyone who knew (or guessed) a user id could delete that account.
  const authUser = await getUserFromEvent(sb, event);
  if (!authUser) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Not signed in' }) };
  }
  const user_id = authUser.id;

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

    // Удаляем историю проверок
    if (monitorIds.length > 0) {
      await sb.from('monitor_checks').delete().in('monitor_id', monitorIds);
      await sb.from('responses').delete().in('monitor_id', monitorIds); // старая таблица, если есть
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
