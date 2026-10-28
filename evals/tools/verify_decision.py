# Recomputes a decision's numbers from its rows.jsonl, independently of the harness (its own CR1 Z, Rule F looks, the
# upper-median paired ratio, the exact session-swap test), and compares them with what verdict.json recorded.
# Usage: python3 -I evals/tools/verify_decision.py ~/rt-eval/runs <run> [<run> ...]   Prints numbers only, never case content.
import json, math, os, random, sys

# Rule F as evals/loop/config.ts has it (LOOP.looks, keepZ, revertZ, minDecisive, rareMin).
LOOKS, KEEPZ, REVZ, MIND = [16, 32, 48, 80, 160], [math.inf, 2.3, 1.9, 1.8, 1.7], [-1, -0.5, 0, 0.6, 1.7], [10, 20, 30, 0, 0]
RARE_MIN = 32


def rows_of(d):
    p = os.path.join(d, "rows.jsonl")
    return [json.loads(l) for l in open(p) if l.strip()] if os.path.exists(p) else []


def z_of(rows, key="s"):
    n = len(rows)
    if not n:
        return 0.0, 0
    s = [r.get(key) or 0 for r in rows]
    mean = sum(s) / n
    by = {}
    for r, x in zip(rows, s):
        by[r["cluster"]] = by.get(r["cluster"], 0.0) + (x - mean)
    G = len(by)
    se = math.sqrt(G / (G - 1) * sum(v * v for v in by.values())) / n if G > 1 else math.inf
    dec = sum(1 for x in s if x != 0)
    se = max(se, math.sqrt(dec / n) / math.sqrt(n))
    return (mean / se if se > 0 and math.isfinite(se) else 0.0), dec


def rule_f(rows, shift=0.0):
    looks = []
    for i, n in enumerate(LOOKS):
        if len(rows) < n and len(rows) < RARE_MIN:
            return looks, None, None
        if len(rows) < n:
            # Out of cases short of look n: one last look on them all at n's keep line.
            z, dec = z_of(rows)
            looks.append({"n": len(rows), "decisive": dec, "z": z})
            return looks, z >= KEEPZ[i] + shift, len(rows)
        z, dec = z_of(rows[:n])
        looks.append({"n": n, "decisive": dec, "z": z})
        if dec < MIND[i] and i < len(LOOKS) - 1:
            continue
        if z >= KEEPZ[i] + shift:
            return looks, True, n
        if z <= REVZ[i]:
            return looks, False, n
    return looks, False, LOOKS[-1]


def val(r, m, arm):
    v = (r.get(m) or [None, None])[arm]
    return max(v, 1) if m == "render" and isinstance(v, (int, float)) else v


def paired(rows, m):
    return [r for r in rows if not r.get("void") and (val(r, m, 0) or 0) > 0 and (val(r, m, 1) or 0) > 0]


def umed(xs):
    s = sorted(xs)
    return s[len(s) >> 1]


def swap(rows, m):
    """(B/A median ratio, p slower, p faster, sessions): exact over all 2^G session swaps when G <= 11, else 20,000 draws."""
    ok = paired(rows, m)
    if not ok:
        return None
    groups = {}
    for i, r in enumerate(ok):
        groups.setdefault(r["cluster"], []).append(i)
    gl = list(groups.values())
    G = len(gl)
    lg = [math.log(val(r, m, 1) / val(r, m, 0)) for r in ok]

    def stat(sw):
        return umed([(-lg[i] if sw[j] else lg[i]) for j, g in enumerate(gl) for i in g])

    obs = stat([False] * G)
    if G <= 11:
        pats = [[(k >> j) & 1 == 1 for j in range(G)] for k in range(2**G)]
    else:
        rnd = random.Random(1)
        pats = [[rnd.random() < 0.5 for _ in range(G)] for _ in range(20000)]
    above = sum(stat(p) >= obs - 1e-12 for p in pats)
    below = sum(stat(p) <= obs + 1e-12 for p in pats)
    k = len(pats)
    exact = G <= 11
    return {"est": math.exp(obs), "slower": above / k if exact else (above + 1) / (k + 1), "faster": below / k if exact else (below + 1) / (k + 1), "G": G, "exact": exact}


def close(a, b, tol=1e-6):
    return a is not None and b is not None and abs(a - b) <= tol * max(1.0, abs(a), abs(b))


def main():
    runs_dir = sys.argv[1]
    for run in sys.argv[2:]:
        d = os.path.join(runs_dir, run)
        v = json.load(open(os.path.join(d, "verdict.json"))) if os.path.exists(os.path.join(d, "verdict.json")) else None
        rows = rows_of(d)
        live = [r for r in rows if not r.get("void")]
        print(f"== {run}: {len(rows)} rows, {len(rows) - len(live)} void")
        if not v:
            print("   no verdict.json")
            continue
        print(f"   recorded: {v['verdict']} class {v['class']} goal {v['goal']}; reasons: {'; '.join(v.get('reasons', []))[:300]}; vetoes: {'; '.join(v.get('vetoes', []))[:300] or 'none'}")
        if v["class"] in ("N",) or not live:
            continue
        key = "sCraft" if v["goal"] == "craft" else "s"
        at = live[: v.get("counts", {}).get("look") or len(live)]
        wins, losses = sum((r.get(key) or 0) > 0 for r in at), sum((r.get(key) or 0) < 0 for r in at)
        c = v.get("counts", {})
        print(f"   counts at look {c.get('look')}: recomputed {wins}W {losses}L {len(at) - wins - losses}T, recorded {c.get('wins')}W {c.get('losses')}L {c.get('ties')}T -> {'MATCH' if (wins, losses) == (c.get('wins'), c.get('losses')) else 'DIFF'}")
        if v["goal"] != "latency":
            looks, keep, n = rule_f(live)
            for mine, theirs in zip(looks, v.get("looks", [])):
                ok = mine["n"] == theirs["n"] and mine["decisive"] == theirs["decisive"] and close(mine["z"], theirs["z"])
                print(f"   look {mine['n']}: Z {mine['z']:.4f} ({mine['decisive']} decisive) vs recorded {theirs['z']:.4f} ({theirs['decisive']}) -> {'MATCH' if ok else 'DIFF'}")
            print(f"   Rule F (sweep shift 0) says {'keep' if keep else 'revert' if keep is False else 'undecided'} at look {n}")
        for m in ("ttfd", "render", "ttfc"):
            mine = swap(at, m)
            theirs = (v.get("latency") or {}).get(m)
            if not mine or not theirs:
                print(f"   {m}: recomputed {mine}, recorded {theirs}")
                continue
            p = theirs.get("p") or {}
            same_est = close(mine["est"], theirs["est"])
            same_p = mine["exact"] and close(mine["slower"], p.get("slower")) and close(mine["faster"], p.get("faster"))
            tag = "MATCH" if same_est and (same_p or not mine["exact"]) else "DIFF"
            print(f"   {m} median B/A: ×{mine['est']:.4f} vs ×{theirs['est']:.4f}; swap p slower {mine['slower']:.4f} vs {p.get('slower', float('nan')):.4f}, faster {mine['faster']:.4f} vs {p.get('faster', float('nan')):.4f} ({mine['G']} sessions, {'exact' if mine['exact'] else 'sampled'}) -> {tag}")


main()
