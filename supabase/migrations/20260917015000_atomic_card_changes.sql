-- This migration is additive. Existing REST clients still work until a separate
-- frontend rollout replaces their writes with apply_card_change(). Do not revoke
-- legacy table DML until every supported client uses the RPC.
ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Track content updates from older REST clients as well. Opening a card only
-- changes last_used and must not create an editing conflict.
CREATE OR REPLACE FUNCTION public.cards_track_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF ROW(NEW.store, NEW.number, NEW.color_a, NEW.color_b,
         NEW.text_color, NEW.format, NEW.code_image, NEW.deleted_at)
     IS DISTINCT FROM
     ROW(OLD.store, OLD.number, OLD.color_a, OLD.color_b,
         OLD.text_color, OLD.format, OLD.code_image, OLD.deleted_at)
  THEN
    NEW.revision := OLD.revision + 1;
  ELSE
    NEW.revision := OLD.revision;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cards_revision_trigger ON public.cards;
CREATE TRIGGER cards_revision_trigger
BEFORE UPDATE ON public.cards
FOR EACH ROW EXECUTE FUNCTION public.cards_track_revision();

-- CAS: an UPDATE with a revision predicate acquires a row lock, and PostgreSQL
-- rechecks that predicate after waiting for a concurrent UPDATE. Exactly one
-- writer can modify any given revision; the other gets SYNC_CONFLICT.
CREATE OR REPLACE FUNCTION public.apply_card_change(
  p_card_id uuid,
  p_expected_revision bigint,
  p_delete boolean,
  p_card jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_revision bigint;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_card_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 0
     OR p_delete IS NULL THEN
    RAISE EXCEPTION 'Invalid card mutation' USING ERRCODE = '22023';
  END IF;
  IF NOT p_delete AND (p_card IS NULL OR jsonb_typeof(p_card) <> 'object') THEN
    RAISE EXCEPTION 'Card data is required' USING ERRCODE = '22023';
  END IF;

  IF p_expected_revision = 0 THEN
    IF p_delete THEN
      RAISE EXCEPTION 'SYNC_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
    BEGIN
      INSERT INTO public.cards (
        user_id, id, store, number, color_a, color_b, text_color,
        last_used, format, code_image, revision, deleted_at
      ) VALUES (
        v_user, p_card_id, p_card->>'store', p_card->>'number',
        p_card->>'color_a', p_card->>'color_b',
        COALESCE(p_card->>'text_color', '#fff'),
        COALESCE((p_card->>'last_used')::bigint, 0),
        COALESCE(p_card->>'format', 'code_128'),
        p_card->>'code_image', 1, NULL
      ) RETURNING revision INTO v_revision;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'SYNC_CONFLICT' USING ERRCODE = 'P0001';
    END;
  ELSIF p_delete THEN
    -- A tombstone preserves the revision but discards the removed card's code.
    UPDATE public.cards
       SET store = 'Удалена', number = '0',
           color_a = '#000', color_b = '#000', text_color = '#fff',
           format = 'code_128', code_image = NULL,
           deleted_at = clock_timestamp()
     WHERE user_id = v_user AND id = p_card_id
       AND revision = p_expected_revision AND deleted_at IS NULL
     RETURNING revision INTO v_revision;
  ELSE
    UPDATE public.cards
       SET store = p_card->>'store',
           number = p_card->>'number',
           color_a = p_card->>'color_a',
           color_b = p_card->>'color_b',
           text_color = COALESCE(p_card->>'text_color', '#fff'),
           last_used = COALESCE((p_card->>'last_used')::bigint, 0),
           format = COALESCE(p_card->>'format', 'code_128'),
           code_image = p_card->>'code_image'
     WHERE user_id = v_user AND id = p_card_id
       AND revision = p_expected_revision AND deleted_at IS NULL
     RETURNING revision INTO v_revision;
  END IF;

  IF v_revision IS NULL THEN
    RAISE EXCEPTION 'SYNC_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object('revision', v_revision, 'deleted', p_delete);
END;
$$;

-- The function acts as the signed-in caller; RLS still governs the table.
REVOKE ALL ON FUNCTION public.apply_card_change(uuid, bigint, boolean, jsonb)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_card_change(uuid, bigint, boolean, jsonb)
TO authenticated;
