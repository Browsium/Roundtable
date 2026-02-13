-- D1 Schema Migration: 002_add_analysis_backend_columns
-- Adds provider/model fields to persist which backend was used for a given session/persona analysis.

ALTER TABLE sessions ADD COLUMN analysis_provider TEXT;
ALTER TABLE sessions ADD COLUMN analysis_model TEXT;

ALTER TABLE analyses ADD COLUMN analysis_provider TEXT;
ALTER TABLE analyses ADD COLUMN analysis_model TEXT;

