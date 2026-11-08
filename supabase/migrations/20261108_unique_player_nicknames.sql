-- Run this migration in the Supabase SQL Editor after checking existing duplicate names.
-- It intentionally stops if duplicate normalized nicknames already exist; resolve those
-- accounts manually first rather than silently renaming or merging player identities.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.brain_players
    GROUP BY lower(btrim(regexp_replace(nickname, '\\s+', ' ', 'g')))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate player nicknames exist. Review and resolve them manually before applying this migration.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS brain_players_nickname_normalized_uidx
ON public.brain_players (
  lower(btrim(regexp_replace(nickname, '\\s+', ' ', 'g')))
);
