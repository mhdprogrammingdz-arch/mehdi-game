import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const categories = new Set(['riddles','knowledge','technology','politics','history','challenge']);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!url || !serviceKey || !authHeader.startsWith('Bearer ')) return json({ error: 'يلزم تسجيل جلسة لاعب صالحة.' }, 401);
  const authClient = createClient(url, Deno.env.get('SUPABASE_ANON_KEY') ?? '', { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
  const { data: authData, error: authError } = await authClient.auth.getUser();
  if (authError || !authData.user) return json({ error: 'جلسة اللاعب غير صالحة. أعد تحميل الصفحة.' }, 401);
  const userId = authData.user.id;
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });
  try {
    const body = await req.json();
    if (body.action === 'register') {
      const nickname = String(body.nickname ?? '').trim().replace(/\s+/g, ' ');
      if (nickname.length < 2 || nickname.length > 24) return json({ error: 'الاسم يجب أن يكون بين حرفين و24 حرفاً.' }, 400);
      // Nicknames are global identities: reject a name already owned by another account.
      // The database unique index added by the companion migration is the final race-safe guard.
      const { data: nameOwner, error: nameError } = await db.from('brain_players')
        .select('id,user_id,nickname')
        .ilike('nickname', nickname)
        .neq('user_id', userId)
        .limit(1)
        .maybeSingle();
      if (nameError) throw nameError;
      if (nameOwner) return json({ error: 'هذا الاسم مستخدم بالفعل. اختر اسماً آخر لاستخدامه.' }, 409);

      const { data, error } = await db.from('brain_players').upsert({ user_id: userId, nickname }, { onConflict: 'user_id' }).select('id,nickname').single();
      if (error) {
        if (error.code === '23505') return json({ error: 'هذا الاسم مستخدم بالفعل. اختر اسماً آخر لاستخدامه.' }, 409);
        throw error;
      }
      return json({ player: data });
    }
    const { data: player, error: playerError } = await db.from('brain_players').select('id,nickname').eq('user_id', userId).maybeSingle();
    if (playerError) throw playerError;
    if (!player) return json({ error: 'سجّل اسم اللاعب أولاً.' }, 403);

    if (body.action === 'leaderboard') {
      const category = String(body.category ?? 'challenge');
      if (!categories.has(category)) return json({ error: 'القسم غير صحيح.' }, 400);
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Algiers', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      // Aggregate every verified round by normalized nickname for this category/day.
      // Paginate because Supabase may cap a single response at 1,000 rows.
      const allScores: any[] = [];
      const pageSize = 1000;
      for (let from = 0; ; from += pageSize) {
        const { data, error } = await db.from('brain_scores')
          .select('score,category,played_on,created_at,brain_players!inner(nickname)')
          .eq('category', category).eq('played_on', today)
          .order('created_at', { ascending: true })
          .range(from, from + pageSize - 1);
        if (error) throw error;
        const page = data ?? [];
        allScores.push(...page);
        if (page.length < pageSize) break;
      }

      const grouped = new Map<string, { nickname: string; category: string; score: number; rounds: number; played_on: string }>();
      for (const row of allScores) {
        const nickname = String(row.brain_players?.nickname ?? 'لاعب').trim().replace(/\\s+/g, ' ');
        const key = nickname.toLocaleLowerCase('ar');
        const existing = grouped.get(key);
        if (existing) {
          existing.score += Number(row.score) || 0;
          existing.rounds += 1;
        } else {
          grouped.set(key, { nickname, category: row.category, score: Number(row.score) || 0, rounds: 1, played_on: row.played_on });
        }
      }
      const results = [...grouped.values()]
        .sort((a, b) => b.score - a.score || b.rounds - a.rounds || a.nickname.localeCompare(b.nickname, 'ar'))
        .slice(0, 100);
      return json({ results });
    }
    if (body.action === 'start') {
      const category = String(body.category ?? '');
      if (!categories.has(category)) return json({ error: 'القسم غير صحيح.' }, 400);
      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count: recentRounds, error: rateError } = await db.from('brain_sessions').select('id', { count: 'exact', head: true }).eq('player_id', player.id).gte('created_at', since);
      if (rateError) throw rateError;
      if ((recentRounds ?? 0) >= 20) return json({ error: 'وصلت إلى الحد المؤقت: 20 جولة في الساعة. حاول لاحقاً.' }, 429);
      let query = db.from('brain_questions').select('id,category,question,options').eq('active', true);
      if (category !== 'challenge') query = query.eq('category', category);
      const { data: pool, error } = await query;
      if (error) throw error;
      if (!pool || pool.length < 10) return json({ error: 'لا توجد أسئلة كافية لهذا القسم بعد.' }, 409);

      // Per-player question history: question IDs are recorded in brain_sessions,
      // so no schema migration or browser-side storage is needed. History is
      // shared across categories to avoid seeing the same question in another mode.
      const { data: history, error: historyError } = await db.from('brain_sessions')
        .select('question_ids,created_at')
        .eq('player_id', player.id)
        .order('created_at', { ascending: false })
        .limit(500);
      if (historyError) throw historyError;
      const pastRounds = history ?? [];
      const seen = new Set<string>();
      for (const round of pastRounds) {
        for (const id of (round.question_ids ?? [])) seen.add(String(id));
      }

      // First exhaust questions this player has never seen. When fewer than
      // ten remain, gradually allow older questions back, while protecting the
      // most recent rounds from immediate repetition.
      let candidates = pool.filter((q: any) => !seen.has(String(q.id)));
      if (candidates.length < 10) {
        for (const protectedRounds of [3, 2, 1, 0]) {
          const protectedIds = new Set<string>();
          for (const round of pastRounds.slice(0, protectedRounds)) {
            for (const id of (round.question_ids ?? [])) protectedIds.add(String(id));
          }
          candidates = pool.filter((q: any) => !protectedIds.has(String(q.id)));
          if (candidates.length >= 10) break;
        }
      }
      if (candidates.length < 10) candidates = [...pool]; // final fallback for small question banks

      // Fisher-Yates shuffle; no answer key or explanation is sent to the browser.
      const shuffled = [...candidates];
      for (let i = shuffled.length - 1; i > 0; i--) { const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
      const chosen = shuffled.slice(0, 10);
      const { data: session, error: sessionError } = await db.from('brain_sessions').insert({
        player_id: player.id, category, question_ids: chosen.map((q: any) => q.id),
      }).select('id,expires_at').single();
      if (sessionError) throw sessionError;
      return json({ sessionId: session.id, expiresAt: session.expires_at, questions: chosen });
    }
    if (body.action === 'submit') {
      const sessionId = String(body.sessionId ?? '');
      const answers = body.answers;
      if (!/^[0-9a-f-]{36}$/i.test(sessionId) || !Array.isArray(answers)) return json({ error: 'صيغة الإجابات غير صحيحة.' }, 400);
      const { data: session, error: sessionError } = await db.from('brain_sessions').select('id,player_id,expires_at,submitted_at').eq('id', sessionId).maybeSingle();
      if (sessionError) throw sessionError;
      if (!session || session.player_id !== player.id) return json({ error: 'الجولة غير موجودة لهذا اللاعب.' }, 404);
      if (session.submitted_at) return json({ error: 'تم إرسال نتيجة هذه الجولة سابقاً.' }, 409);
      if (new Date(session.expires_at).getTime() < Date.now()) return json({ error: 'انتهت صلاحية الجولة.' }, 410);
      const { data, error } = await db.rpc('submit_brain_session', { p_session_id: sessionId, p_answers: answers });
      if (error) {
        if (error.message?.includes('already_submitted')) return json({ error: 'تم إرسال نتيجة هذه الجولة سابقاً.' }, 409);
        if (error.message?.includes('session_expired')) return json({ error: 'انتهت صلاحية الجولة.' }, 410);
        if (error.code === '22023') return json({ error: 'الإجابات غير صالحة أو مكررة.' }, 400);
        throw error;
      }
      const row = data?.[0];
      return json({ verified: true, score: row.score, total: 10, category: row.category, message: 'تم التحقق من النتيجة وتسجيلها على الخادم.' });
    }
    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    console.error('brain-game error:', e);
    return json({ error: 'حدث خطأ داخلي أثناء معالجة الجولة.' }, 500);
  }
});
