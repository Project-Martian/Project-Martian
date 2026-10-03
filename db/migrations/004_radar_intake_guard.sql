-- A backup deliberately omits private control rows. Restored intake stays disabled
-- until an owner explicitly initializes controls, even if its web credential exists.
CREATE OR REPLACE FUNCTION radar_public.receive_intake(kind text, payload jsonb, client_key text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE receipt uuid; used integer; intake_hour timestamptz := date_trunc('hour',now());
BEGIN
  IF NOT COALESCE((SELECT intake_enabled FROM radar_private.control),false) THEN RAISE EXCEPTION 'intake disabled' USING ERRCODE='55000'; END IF;
  IF kind NOT IN ('submission','report') OR octet_length(payload::text)>20000 OR client_key !~ '^[a-f0-9]{64}$'
    THEN RAISE EXCEPTION 'invalid intake' USING ERRCODE='22023'; END IF;
  INSERT INTO radar_private.intake_limits VALUES ('global',intake_hour,1)
    ON CONFLICT(key,hour) DO UPDATE SET count=radar_private.intake_limits.count+1 RETURNING count INTO used;
  IF used>200 THEN RAISE EXCEPTION 'intake limited' USING ERRCODE='P0001'; END IF;
  INSERT INTO radar_private.intake_limits VALUES (client_key,intake_hour,1)
    ON CONFLICT(key,hour) DO UPDATE SET count=radar_private.intake_limits.count+1 RETURNING count INTO used;
  IF used>10 THEN RAISE EXCEPTION 'intake limited' USING ERRCODE='P0001'; END IF;
  INSERT INTO radar_private.intake(kind,content) VALUES(kind,payload) RETURNING id INTO receipt;
  RETURN receipt;
END $$;
