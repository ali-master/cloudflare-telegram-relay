import {env} from 'cloudflare:workers';
import {evictDurableObject, runInDurableObject} from 'cloudflare:test';
import {describe, expect, it} from 'vitest';
import type {Env} from '../src/types';

const bindings = env as unknown as Env;

describe('application escalation cleanup', () => {
  it('retains incident ownership across cleanup pages and eviction without touching another application', async () => {
    const hub = bindings.HUB.getByName(`escalation-cleanup-${crypto.randomUUID()}`);
    await hub.getSettings();
    await runInDurableObject(hub, (_, state) => {
      const sql = state.storage.sql;
      sql.exec("INSERT INTO subscribers(chat_id,first_name,joined_at,updated_at) VALUES('1','Cleanup fixture',1,1)");
      for (const [id, applicationId] of [['removed-incident', 'removed-app'], ['kept-incident', 'kept-app']]) {
        sql.exec("INSERT INTO incidents(id,application_id,fingerprint,status,first_seen,last_seen,window_end,body) VALUES(?,?,?,'open',1,1,1,'{}')", id, applicationId, id);
      }
      // Include legacy payload-only rows and newer explicitly linked rows,
      // plus both pending sends and previously delivered history.
      sql.exec(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 1001)
                INSERT
                INTO deliveries(chat_id,incident_id,rendered,system_payload,status,updated_at)
      SELECT '1',
             CASE WHEN n = 1 THEN 'removed-incident' ELSE NULL END,
             'Removed escalation',
             '{"escalationIncident":"removed-incident"}',
             CASE WHEN n%2=0 THEN 'sent' ELSE 'pending' END,
             1
      FROM seq`);
      sql.exec("INSERT INTO deliveries(chat_id,rendered,system_payload,updated_at) VALUES('1','Other escalation','{\"escalationIncident\":\"kept-incident\"}',1)");
    });
    
    /** Observe ownership and payload retention directly, independent of dashboard filters. */
    const snapshot = () => runInDurableObject(hub, (_, state) => ({
      removedDeliveries: state.storage.sql.exec("SELECT COUNT(*) AS count FROM deliveries WHERE incident_id='removed-incident' OR json_extract(system_payload,'$.escalationIncident')='removed-incident'").one().count,
      removedIncidents: state.storage.sql.exec("SELECT COUNT(*) AS count FROM incidents WHERE id='removed-incident'").one().count,
      keptDeliveries: state.storage.sql.exec("SELECT COUNT(*) AS count FROM deliveries WHERE json_extract(system_payload,'$.escalationIncident')='kept-incident' AND status='pending'").one().count,
      keptIncidents: state.storage.sql.exec("SELECT COUNT(*) AS count FROM incidents WHERE id='kept-incident'").one().count,
      subscribers: state.storage.sql.exec('SELECT COUNT(*) AS count FROM subscribers').one().count,
    }));
    
    expect(await hub.removeApplication('removed-app')).toBe(false);
    expect(await snapshot()).toEqual({
      removedDeliveries: 501,
      removedIncidents: 1,
      keptDeliveries: 1,
      keptIncidents: 1,
      subscribers: 1
    });
    await evictDurableObject(hub);
    expect(await hub.removeApplication('removed-app')).toBe(false);
    expect(await snapshot()).toEqual({
      removedDeliveries: 1,
      removedIncidents: 1,
      keptDeliveries: 1,
      keptIncidents: 1,
      subscribers: 1
    });
    expect(await hub.removeApplication('removed-app')).toBe(true);
    expect(await snapshot()).toEqual({
      removedDeliveries: 0,
      removedIncidents: 0,
      keptDeliveries: 1,
      keptIncidents: 1,
      subscribers: 1
    });
  });
});
