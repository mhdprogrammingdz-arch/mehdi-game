import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const categories = new Set(['riddles','knowledge','technology','politics','history','mathematics','challenge']);
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
      // Global permanent leaderboard: combine verified scores from every game
      // category and every date, keeping exactly one row per player account.
      // Paginate because Supabase may cap a single response at 1,000 rows.
      const allScores: any[] = [];
      const pageSize = 1000;
      for (let from = 0; ; from += pageSize) {
        const { data, error } = await db.from('brain_scores')
          .select('player_id,score,category,played_on,created_at,brain_players!inner(id,nickname)')
          .order('created_at', { ascending: true })
          .range(from, from + pageSize - 1);
        if (error) throw error;
        const page = data ?? [];
        allScores.push(...page);
        if (page.length < pageSize) break;
      }

      const grouped = new Map<string, { nickname: string; category: string; score: number; rounds: number; played_on: string }>();
      for (const row of allScores) {
        const nickname = String(row.brain_players?.nickname ?? 'لاعب').trim().replace(/\s+/g, ' ');
        const key = String(row.player_id);
        const existing = grouped.get(key);
        if (existing) {
          existing.score += Number(row.score) || 0;
          existing.rounds += 1;
        } else {
          grouped.set(key, { nickname, category: 'all', score: Number(row.score) || 0, rounds: 1, played_on: row.played_on });
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
      let query = db.from('brain_questions').select('id,category,question,options').eq('active', true).order('id', { ascending: true });
      if (category !== 'challenge') query = query.eq('category', category);
      const { data: rawPool, error } = await query;
      if (error) throw error;
      if (!rawPool?.length) return json({ error: 'تشخيص: لم يتم جلب أي سؤال من قاعدة البيانات.', diagnostic: { category, rawQuestions: 0 } }, 409);

      const normalize = (value: unknown) => String(value ?? '')
        .normalize('NFKC')
        .toLocaleLowerCase()
        .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
        .replace(/[أإآ]/g, 'ا')
        .replace(/ى/g, 'ي')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();

      // Read answer keys server-side so duplicate detection compares the
      // question, its four answer choices, and the correct choice.
      const questionIds = rawPool.map((q: any) => String(q.id));
      const { data: keyRows, error: keyError } = await db.from('brain_answer_keys')
        .select('question_id,correct_index')
        .in('question_id', questionIds);
      if (keyError) throw keyError;
      const answerKeyById = new Map<string, number>();
      for (const row of keyRows ?? []) answerKeyById.set(String(row.question_id), Number(row.correct_index));

      const uniqueQuestions = new Map<string, any>();
      for (const q of rawPool as any[]) {
        const opts = Array.isArray(q.options) ? q.options.map((x: unknown) => normalize(x)) : [];
        const correctIndex = answerKeyById.get(String(q.id));
        if (!normalize(q.question) || opts.length !== 4 || correctIndex === undefined) continue;
        // A question is identified by its normalized wording alone.
        // This prevents the same prompt appearing multiple times even when
        // duplicate rows have different option ordering or answer-key records.
        const duplicateKey = normalize(q.question);
        if (!uniqueQuestions.has(duplicateKey)) uniqueQuestions.set(duplicateKey, q);
      }
      const pool = [...uniqueQuestions.values()];
      if (!pool.length) {
        const optionsArrayCount = (rawPool as any[]).filter((q: any) => Array.isArray(q.options)).length;
        const fourOptionsCount = (rawPool as any[]).filter((q: any) => Array.isArray(q.options) && q.options.length === 4).length;
        const answerKeyCount = answerKeyById.size;
        return json({
          error: 'تشخيص: تم جلب الأسئلة لكن لم يجتز أي سؤال شروط الصلاحية.',
          diagnostic: { category, rawQuestions: rawPool.length, optionsArrayCount, fourOptionsCount, answerKeyCount }
        }, 409);
      }

      // History is isolated by player AND category, and only successfully
      // submitted rounds consume questions. Abandoned sessions do not.
      const pastRounds: any[] = [];
      const historyPageSize = 1000;
      for (let from = 0; ; from += historyPageSize) {
        const { data: historyPage, error: historyError } = await db.from('brain_sessions')
          .select('id,question_ids,created_at,submitted_at')
          .eq('player_id', player.id)
          .eq('category', category)
          .not('submitted_at', 'is', null)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, from + historyPageSize - 1);
        if (historyError) throw historyError;
        const page = historyPage ?? [];
        pastRounds.push(...page);
        if (page.length < historyPageSize) break;
      }

      const poolIds = new Set(pool.map((q: any) => String(q.id)));
      const seen = new Set<string>();
      for (const round of pastRounds) {
        for (const id of (round.question_ids ?? [])) {
          if (poolIds.has(String(id))) seen.add(String(id));
        }
      }
      const shuffle = <T>(items: T[]) => {
        const result = [...items];
        for (let i = result.length - 1; i > 0; i--) {
          const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
          [result[i], result[j]] = [result[j], result[i]];
        }
        return result;
      };

      const unseen = pool.filter((q: any) => !seen.has(String(q.id)));
      let chosen: any[];
      if (unseen.length > 0) {
        // A final short round is allowed when fewer than ten new questions remain.
        chosen = shuffle(unseen).slice(0, Math.min(10, unseen.length));
      } else {
        // All unique questions in this category have been answered: start a
        // fresh randomized cycle, avoiding the exact previous round order.
        const lastRound = pastRounds[pastRounds.length - 1];
        let shuffled = shuffle(pool);
        const lastIds = (lastRound?.question_ids ?? []).map(String);
        const sameOrder = (a: any[], b: string[]) =>
          a.length === b.length && a.every((q, i) => String(q.id) === b[i]);
        if (shuffled.length > 1 && sameOrder(shuffled.slice(0, Math.min(10, shuffled.length)), lastIds)) {
          [shuffled[0], shuffled[1]] = [shuffled[1], shuffled[0]];
        }
        chosen = shuffled.slice(0, Math.min(10, shuffled.length));
      }

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
      return json({ verified: true, score: row.score, total: answers.length, category: row.category, message: 'تم التحقق من النتيجة وتسجيلها على الخادم.' });
    }
    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    console.error('brain-game error:', e);
    return json({ error: 'حدث خطأ داخلي أثناء معالجة الجولة.' }, 500);
  }
});
