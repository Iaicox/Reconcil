import { createDb, runMigrations, type Db } from '@pet-crypto/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ToolContext } from '../src/context.js';
import { directoryListEntities } from '../src/tools/directory-list-entities.js';
import { directoryUpsertEntity } from '../src/tools/directory-upsert-entity.js';
import { EXT, EXT2, TENANT, TENANT2, makeSeeder, type Seeder } from './seed.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;
let S: Seeder;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool);
  db = createDb(pool);
  S = makeSeeder(pool, db);
}, 120_000);

afterAll(async () => { await pool.end(); await container.stop(); });

beforeEach(async () => {
  await S.truncate();
  await S.tenant(TENANT, 'acme');
});

const ctx: () => ToolContext = () => ({ db, tenantId: TENANT });

describe('directory_upsert_entity / directory_list_entities — address book (§6.3)', () => {
  it('creates an entity with addresses, then updates it in place; persists tool_calls (C2)', async () => {
    const created = await directoryUpsertEntity(ctx(), {
      name: 'Acme Vendor', kind: 'vendor', addresses: [{ chain_id: 1, address: EXT }],
    });
    expect(created.data.created).toBe(true);
    const id = created.data.entity_id;

    const listed = await directoryListEntities(ctx(), {});
    expect(listed.data.entities).toHaveLength(1);
    expect(listed.data.entities[0]).toMatchObject({
      entity_id: id, name: 'Acme Vendor', kind: 'vendor', curated: false,
      addresses: [{ chain_id: 1, address: EXT }],
    });

    const updated = await directoryUpsertEntity(ctx(), { entity_id: id, name: 'Acme LLC', kind: 'vendor' });
    expect(updated.data).toEqual({ entity_id: id, created: false });
    const relisted = await directoryListEntities(ctx(), {});
    expect(relisted.data.entities[0]?.name).toBe('Acme LLC');

    const { rows } = await pool.query(`SELECT tool_name, tenant_id FROM tool_calls WHERE tool_name = 'directory_upsert_entity'`);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ tenant_id: TENANT });
  });

  it('denormalizes tenant_id onto entity_addresses (the in-DB uniqueness key)', async () => {
    await directoryUpsertEntity(ctx(), { name: 'V', kind: 'vendor', addresses: [{ chain_id: 1, address: EXT }] });
    const { rows } = await pool.query(`SELECT tenant_id FROM entity_addresses WHERE address = $1`, [EXT]);
    expect(rows[0]).toMatchObject({ tenant_id: TENANT });
  });

  it('refuses to modify a curated (tenant_id NULL) entity', async () => {
    const curated = await S.entity({ tenantId: null, name: 'Binance', kind: 'exchange' });
    await expect(
      directoryUpsertEntity(ctx(), { entity_id: curated, name: 'Hijacked', kind: 'exchange' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('enforces one owner per (tenant, chain, address); re-adding to the same entity is idempotent', async () => {
    const a = await directoryUpsertEntity(ctx(), { name: 'A', kind: 'vendor', addresses: [{ chain_id: 1, address: EXT }] });
    // A different entity claiming EXT is rejected, and its half-built row is rolled back.
    await expect(
      directoryUpsertEntity(ctx(), { name: 'B', kind: 'vendor', addresses: [{ chain_id: 1, address: EXT }] }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await directoryListEntities(ctx(), {})).data.entities).toHaveLength(1);

    // The owner re-adding the same address is a no-op, not a conflict.
    const again = await directoryUpsertEntity(ctx(), { entity_id: a.data.entity_id, name: 'A', kind: 'vendor', addresses: [{ chain_id: 1, address: EXT }] });
    expect(again.data.created).toBe(false);
  });

  it('is tenant-scoped: a tenant sees its own entities plus curated, never another tenant’s', async () => {
    await S.tenant(TENANT2, 'other');
    const ctx2: ToolContext = { db, tenantId: TENANT2 };
    await directoryUpsertEntity(ctx2, { name: 'T2 Only', kind: 'client' });
    const curated = await S.entity({ tenantId: null, name: 'Curated Exchange', kind: 'exchange' });
    await S.entityAddress({ entityId: curated, tenantId: null, chainId: null, address: EXT2 });
    await directoryUpsertEntity(ctx(), { name: 'Mine', kind: 'vendor' });

    const names = (await directoryListEntities(ctx(), {})).data.entities.map((e) => e.name).sort();
    expect(names).toEqual(['Curated Exchange', 'Mine']); // no 'T2 Only'
    const curatedRow = (await directoryListEntities(ctx(), {})).data.entities.find((e) => e.name === 'Curated Exchange');
    expect(curatedRow?.curated).toBe(true);
  });

  it('filters by query, kind, and address', async () => {
    await directoryUpsertEntity(ctx(), { name: 'Alpha Corp', kind: 'vendor', addresses: [{ chain_id: 1, address: EXT }] });
    await directoryUpsertEntity(ctx(), { name: 'Beta Exchange', kind: 'exchange' });

    expect((await directoryListEntities(ctx(), { query: 'Alph' })).data.entities.map((e) => e.name)).toEqual(['Alpha Corp']);
    expect((await directoryListEntities(ctx(), { kind: 'exchange' })).data.entities.map((e) => e.name)).toEqual(['Beta Exchange']);
    expect((await directoryListEntities(ctx(), { address: EXT })).data.entities.map((e) => e.name)).toEqual(['Alpha Corp']);
    expect((await directoryListEntities(ctx(), { address: EXT2 })).data.entities).toHaveLength(0);
  });

  it('sanitizes hostile names and warns SANITIZED_HEAVY when heavily stripped (§7)', async () => {
    const env = await directoryUpsertEntity(ctx(), { name: '‮‮‮AB', kind: 'other' });
    expect(env.warnings.map((w) => w.code)).toContain('SANITIZED_HEAVY');
    const listed = await directoryListEntities(ctx(), {});
    expect(listed.data.entities[0]?.name).toBe('AB'); // bidi overrides stripped
  });

  it('rejects malformed input with INVALID_INPUT', async () => {
    await expect(directoryUpsertEntity(ctx(), { kind: 'vendor' })).rejects.toMatchObject({ code: 'INVALID_INPUT' }); // name required
    await expect(directoryUpsertEntity(ctx(), { name: 'X', kind: 'not-a-kind' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
