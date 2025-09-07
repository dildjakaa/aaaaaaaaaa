-- SQL_SCHEMA.sql
-- Minimal schema for players table used by the server.
-- Run this in your PostgreSQL database prior to starting the server.

CREATE TABLE IF NOT EXISTS players (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    kills INT NOT NULL DEFAULT 0,
    deaths INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_players_username ON players(username);

-- Notes:
-- - password_hash should be a bcrypt hash (server uses bcrypt.compare).
--   To create a user:
--     INSERT INTO players (username, password_hash)
--     VALUES ('testuser', '$2b$10$eW5zX9k8C5sZx4gC53ZTAeHImkrc9YHcO3U8t0jO1g3a1cF2d3Ck6'); -- hash for 'test123' example
--   Replace the hash with one you generate (do not rely on example).
