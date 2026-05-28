-- Phase 3.4: pg_notify trigger on detector hits.
--
-- The gateway's `PgListenSource` LISTENs on the
-- `kasgraph_detected_pattern` channel and routes payloads to
-- matching GraphQL Subscription consumers. Any writer to
-- `kasgraph_detected_pattern` — the Rust indexer today, manual
-- SQL, future writers — automatically participates because the
-- NOTIFY is fired by an AFTER INSERT trigger on the table.
--
-- Payload shape matches the GraphQL `DetectedPattern` interface
-- (camelCase field names, BIGINT serialized as JSON string so JS
-- consumers don't lose precision past 2^53). The gateway parses
-- this directly into its DetectedPattern TypeScript type.

CREATE OR REPLACE FUNCTION kasgraph_notify_detected_pattern()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_notify(
        'kasgraph_detected_pattern',
        json_build_object(
            'subgraph',       NEW.subgraph,
            'blockHash',      NEW.block_hash,
            'blockDaaScore',  NEW.block_daa_score::text,
            'txHash',         NEW.tx_hash,
            'outputIndex',    NEW.output_index,
            'detectorKind',   NEW.detector_kind,
            'covenantId',     NEW.covenant_id,
            'payload',        NEW.payload
        )::text
    );
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS kasgraph_detected_pattern_notify_trg
    ON kasgraph_detected_pattern;

CREATE TRIGGER kasgraph_detected_pattern_notify_trg
AFTER INSERT ON kasgraph_detected_pattern
FOR EACH ROW
EXECUTE FUNCTION kasgraph_notify_detected_pattern();
