/**
 * #158 — dead code removal.
 *
 * Two shapes of dead thing were removed, and the difference matters:
 *
 *   1. `src/lib/profiler.ts` - a whole module nothing imported. Deleted.
 *   2. Fifteen exported symbols with no importer. Twelve were genuinely
 *      unreferenced and deleted; three turned out to be used INSIDE their own
 *      file and were only un-exported.
 *
 * The issue's method ("count files that mention the name outside its own")
 * is what produced the three false positives, so they are pinned here.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(rel, 'utf-8');

describe('#158 the unreferenced profiler module is gone', () => {
  it('src/lib/profiler.ts no longer exists', () => {
    // It was never imported: only README, PRD, TEAM and the audit docs
    // mentioned it. useProfiler.ts and LatencyHUD.tsx, which those docs also
    // name, were already absent - so the docs described a feature that had
    // been removed piecemeal and left this file behind.
    expect(existsSync('src/lib/profiler.ts')).toBe(false);
  });
});

describe('#158 the genuinely-dead exports are gone', () => {
  const DELETED: Array<[string, string[]]> = [
    ['src/lib/context.ts', ['initContextSystem']],
    [
      'src/lib/model.ts',
      ['isWithinMemoryBudget', 'getQuantizationInfo', 'modelConfig', 'getModelSizeEstimate'],
    ],
    ['src/lib/privacy.ts', ['createPrivacyEvent']],
    ['src/lib/providerConfig.ts', ['getDefaultProvider', 'getProvider']],
    ['src/lib/vision.ts', ['canvasToDataURL', 'imageToCanvas', 'resizeCanvas']],
    ['src/lib/vlmHost.ts', ['vlmHostDetect', 'vlmHostInit']],
  ];

  for (const [file, names] of DELETED) {
    for (const name of names) {
      it(`${file} no longer exports ${name}`, () => {
        const src = read(file);
        expect(src, `${name} is exported again`).not.toMatch(
          new RegExp(`export\\s+(?:async\\s+)?(?:function|const|class)\\s+${name}\\b`)
        );
        // Not merely un-exported either - the implementation is gone.
        expect(src, `${name} body is still present`).not.toMatch(
          new RegExp(`(?:function|const)\\s+${name}\\b`)
        );
      });
    }
  }
});

describe('#158 three symbols were only UN-exported, not deleted', () => {
  // The issue listed these as dead by counting mentions outside their own
  // file. All three are used within it, so deleting them would have broken
  // real code - and for two of them the tsc error would have been a
  // "cannot find name" at a call site, not an unused-symbol warning.
  const KEPT: Array<[string, string]> = [
    ['src/lib/dom.ts', 'getOmittedCount'],
    ['src/lib/userProfile.ts', 'PROFILE_STORAGE_KEY'],
  ];

  for (const [file, name] of KEPT) {
    it(`${file} still defines ${name} but does not export it`, () => {
      const src = read(file);
      expect(src, `${name} was deleted instead of un-exported`).toMatch(
        new RegExp(`(?:function|const)\\s+${name}\\b`)
      );
      expect(src, `${name} is exported again`).not.toMatch(
        new RegExp(`export\\s+(?:async\\s+)?(?:function|const|class)\\s+${name}\\b`)
      );
    });
  }

  it('getModelSizeEstimate was a FOURTH false positive, resolved differently', () => {
    // It looked like the other three: mentioned only inside model.ts, twice.
    // But both callers - isWithinMemoryBudget and getQuantizationInfo - were
    // themselves dead, so once they went, tsc reported it as unused
    // (TS6133) and the honest outcome was deletion after all.
    //
    // This is the dependency-order trap: "used internally" was true when the
    // audit ran, and stopped being true halfway through this same change.
    // The un-export was applied first and had to be undone.
    const src = read('src/lib/model.ts');
    expect(src, 'getModelSizeEstimate should be deleted, not un-exported').not.toMatch(
      /getModelSizeEstimate/
    );
  });
});

describe('#158 no live symbol was collaterally removed', () => {
  // The span-based deletion pass over-reached twice on the first attempt and
  // took out neighbours with it (an unrelated `browser` import, a validator
  // import still used by the outbound scanner). Both were caught by tsc and
  // the Aadhaar blocking test. These guards make the specific casualties
  // permanent regressions.
  it('privacy.ts keeps the validators the outbound scanner calls', () => {
    const src = read('src/lib/privacy.ts');
    expect(src).toMatch(/import\s*\{[^}]*validateAadhaar/);
    expect(src).toMatch(/validatePANShared/);
  });

  it('privacy.ts keeps its PIIDetection type', () => {
    expect(read('src/lib/privacy.ts')).toMatch(/export interface PIIDetection/);
  });

  it('vlmHost.ts keeps every status/ground/close export the SW imports', () => {
    const src = read('src/lib/vlmHost.ts');
    for (const n of ['vlmHostStatus', 'closeVlmHost', 'vlmHostGround', 'vlmHostOcr']) {
      expect(src, `${n} was collaterally removed`).toContain(n);
    }
  });

  it('context.ts keeps its storage helpers', () => {
    expect(read('src/lib/context.ts')).toMatch(/storageGet/);
  });
});
