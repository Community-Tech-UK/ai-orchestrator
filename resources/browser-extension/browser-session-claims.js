// Chrome's session store survives an extension worker restart, but clears when
// Chrome exits, when its tab ids can be reused. All native links share this one
// store. Owners are opaque identities stamped by the authenticated Harness RPC
// boundary; page content and tool payloads cannot choose one.
function createBrowserSessionClaims({ storage, now = Date.now, leaseMs = 30 * 60000 }) {
  const key = 'browserGatewaySessionClaims';
  let tail = Promise.resolve();

  function serial(operation) {
    const work = tail.then(operation);
    tail = work.catch(() => undefined);
    return work;
  }

  async function read() {
    const saved = (await storage.get(key))[key];
    if (saved === undefined) return {};
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
      throw new Error('browser_session_claims_unavailable');
    }
    const claims = {};
    for (const [tabId, claim] of Object.entries(saved)) {
      if (!/^\d+$/.test(tabId) || !claim || typeof claim.owner !== 'string'
        || !Number.isFinite(claim.expiresAt)) throw new Error('browser_session_claims_unavailable');
      if (claim.expiresAt > now()) claims[tabId] = claim;
    }
    return claims;
  }

  async function authorize(command) {
    const tabId = command?.target?.tabId;
    if (!Number.isSafeInteger(tabId) || tabId < 0) return;
    return serial(async () => {
      const claims = await read();
      const owner = command.sessionOwner;
      const held = claims[String(tabId)];
      if (held && held.owner !== owner) throw new Error('browser_tab_held_by_another_session');
      if (owner !== undefined) {
        if (typeof owner !== 'string' || owner.length === 0 || owner.length > 256) {
          throw new Error('browser_session_owner_invalid');
        }
        claims[String(tabId)] = { owner, expiresAt: now() + leaseMs };
        await storage.set({ [key]: claims });
      }
    });
  }

  return {
    authorize,
    rememberOpened: async (command, result) => {
      if (command.command === 'open_tab' && command.sessionOwner && Number.isSafeInteger(result?.tabId)) {
        await authorize({ target: { tabId: result.tabId }, sessionOwner: command.sessionOwner });
      }
    },
    forget: (tabId) => serial(async () => {
      const claims = await read();
      delete claims[String(tabId)];
      await storage.set({ [key]: claims });
    }),
  };
}

// A Chrome profile shares cookies and page storage across its tabs. An OFF
// choice in one Harness therefore cannot remove protection another Harness
// still requires. Retain each native link's choice across extension restarts;
// a disconnected Harness's ON choice remains protective too.
function createSharedBrowserSecretPolicy({ storage }) {
  const key = 'browserGatewaySecretProtectionByHost';
  return {
    stamp: async (command, host, connectedHosts) => {
      const requested = command?.payload?.secretObservationProtectionEnabled;
      if (typeof requested !== 'boolean') return;
      const values = await storage.get(key);
      const saved = values[key];
      if (saved !== undefined && (!saved || typeof saved !== 'object' || Array.isArray(saved)
        || Object.values(saved).some(value => typeof value !== 'boolean'))) {
        throw new Error('browser_secret_protection_policy_unavailable');
      }
      const choices = { ...saved, [host]: requested };
      await storage.set({ [key]: choices });
      command.payload.secretObservationProtectionEnabled = Object.values(choices).some(Boolean)
        || connectedHosts.some(candidate => choices[candidate] !== false);
    },
  };
}
