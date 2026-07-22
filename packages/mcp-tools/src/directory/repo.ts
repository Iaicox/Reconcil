/**
 * Address-book storage (directory_*, §6.3). `listEntities`/`upsertEntity` over
 * `entities` + `entity_addresses`, always tenant-scoped (ADR-006): a tenant sees
 * its own rows plus curated (`tenant_id NULL`) ones, and curated rows are
 * read-only. `entity_addresses.tenant_id` is denormalized from the parent so the
 * one-owner-per-`(tenant, chain, address)` rule is a DB unique constraint — this
 * layer keeps it in sync. Names/notes pass the hostile-string sanitizer (§7).
 */
import {
  sanitize,
  type DirectoryEntityView,
  type DirectoryListEntitiesInput,
  type DirectoryUpsertEntityInput,
  type Warning,
} from '@pet-crypto/core';
import { entities, entityAddresses } from '@pet-crypto/db';
import { and, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';

import type { ToolContext } from '../context.js';
import { ToolError } from '../errors.js';

const NAME_MAX = 64;
const NOTES_MAX = 256;

export async function listEntities(
  ctx: ToolContext,
  input: DirectoryListEntitiesInput,
): Promise<DirectoryEntityView[]> {
  const conds = [or(eq(entities.tenantId, ctx.tenantId), isNull(entities.tenantId))];
  if (input.query !== undefined) conds.push(ilike(entities.name, `%${input.query}%`));
  if (input.kind !== undefined) conds.push(sql`${entities.kind} = ${input.kind}`);

  if (input.address !== undefined) {
    const addr = input.address.toLowerCase();
    const owners = await ctx.db
      .select({ entityId: entityAddresses.entityId })
      .from(entityAddresses)
      .where(
        and(
          eq(entityAddresses.address, addr),
          or(eq(entityAddresses.tenantId, ctx.tenantId), isNull(entityAddresses.tenantId)),
        ),
      );
    const ids = [...new Set(owners.map((o) => o.entityId))];
    if (ids.length === 0) return [];
    conds.push(inArray(entities.id, ids));
  }

  const ents = await ctx.db
    .select({
      id: entities.id,
      tenantId: entities.tenantId,
      name: entities.name,
      kind: entities.kind,
      notes: entities.notes,
    })
    .from(entities)
    .where(and(...conds));
  if (ents.length === 0) return [];

  const addrRows = await ctx.db
    .select({ entityId: entityAddresses.entityId, chainId: entityAddresses.chainId, address: entityAddresses.address })
    .from(entityAddresses)
    .where(inArray(entityAddresses.entityId, ents.map((e) => e.id)));
  const byEntity = new Map<string, Array<{ chain_id: number | null; address: string }>>();
  for (const a of addrRows) {
    const list = byEntity.get(a.entityId) ?? [];
    list.push({ chain_id: a.chainId, address: a.address });
    byEntity.set(a.entityId, list);
  }

  return ents.map((e) => ({
    entity_id: e.id,
    name: e.name,
    kind: e.kind,
    curated: e.tenantId === null,
    addresses: byEntity.get(e.id) ?? [],
    ...(e.notes !== null ? { notes: e.notes } : {}),
  }));
}

export interface UpsertResult {
  entityId: string;
  created: boolean;
  warnings: Warning[];
}

export async function upsertEntity(
  ctx: ToolContext,
  input: DirectoryUpsertEntityInput,
): Promise<UpsertResult> {
  const warnings: Warning[] = [];
  const nameS = sanitize(input.name, { maxLength: NAME_MAX });
  if (nameS.heavy) warnings.push({ code: 'SANITIZED_HEAVY', message: 'entity name was heavily sanitized' });
  const name = nameS.display;

  let notes: string | null = null;
  if (input.notes !== undefined) {
    const n = sanitize(input.notes, { maxLength: NOTES_MAX });
    if (n.heavy) warnings.push({ code: 'SANITIZED_HEAVY', message: 'entity notes were heavily sanitized' });
    notes = n.display;
  }

  const clientId = input.client_id ?? null;

  const result = await ctx.db.transaction(async (tx) => {
    let id: string;
    let created: boolean;

    if (input.entity_id !== undefined) {
      const rows = await tx
        .select({ id: entities.id, tenantId: entities.tenantId })
        .from(entities)
        .where(eq(entities.id, input.entity_id))
        .limit(1);
      const row = rows[0];
      // A curated or other-tenant id is indistinguishable to this tenant → same error.
      if (!row || (row.tenantId !== null && row.tenantId !== ctx.tenantId)) {
        throw new ToolError('INVALID_INPUT', `entity not found: ${input.entity_id}`);
      }
      if (row.tenantId === null) {
        throw new ToolError('INVALID_INPUT', 'curated entities are immutable');
      }
      await tx.update(entities).set({ name, kind: input.kind, notes, clientId }).where(eq(entities.id, row.id));
      id = row.id;
      created = false;
    } else {
      const inserted = await tx
        .insert(entities)
        .values({ tenantId: ctx.tenantId, name, kind: input.kind, notes, clientId })
        .returning({ id: entities.id });
      id = inserted[0]!.id;
      created = true;
    }

    for (const a of input.addresses ?? []) {
      const addr = a.address.toLowerCase();
      const chainId = a.chain_id ?? null;
      // One owner per (tenant, chain, address): a hit for another entity is a conflict,
      // the same entity is idempotent. Curated rows (tenant NULL) never collide here.
      const held = await tx
        .select({ entityId: entityAddresses.entityId })
        .from(entityAddresses)
        .where(
          and(
            eq(entityAddresses.address, addr),
            chainId === null ? isNull(entityAddresses.chainId) : eq(entityAddresses.chainId, chainId),
            eq(entityAddresses.tenantId, ctx.tenantId),
          ),
        )
        .limit(1);
      if (held[0]) {
        if (held[0].entityId !== id) {
          throw new ToolError('INVALID_INPUT', `address already labeled by another entity: ${addr}`);
        }
        continue;
      }
      await tx.insert(entityAddresses).values({ entityId: id, tenantId: ctx.tenantId, chainId, address: addr });
    }

    return { id, created };
  });

  return { entityId: result.id, created: result.created, warnings };
}
