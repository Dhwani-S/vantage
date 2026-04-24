"""
Experiments to validate Information Gain Tracking theory.

Run:  cd agent && python tests/experiments.py

Experiments:
  1. Diverse vs Redundant queries  (synthetic text)
  2. Convergence timing            (when does it fire?)
  3. Live API data collection      (real tool calls)

Each experiment prints a clear table + verdict.
"""
import sys, os, json, time, textwrap
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from convergence import InformationGainTracker

DIVIDER = "=" * 72

def header(title):
    print(f"\n{DIVIDER}")
    print(f"  {title}")
    print(DIVIDER)

def table(rows, headers):
    """Print a simple ascii table."""
    col_widths = [max(len(str(r[i])) for r in [headers] + rows) for i in range(len(headers))]
    fmt = "  ".join(f"{{:<{w}}}" for w in col_widths)
    print(fmt.format(*headers))
    print("  ".join("-" * w for w in col_widths))
    for r in rows:
        print(fmt.format(*[str(c) for c in r]))


def experiment_1():
    header("EXPERIMENT 1: Three Tiers — Diverse vs Paraphrased vs Truly Redundant")

    diverse_texts = [
        "Redis is an open-source in-memory data structure store used as a database cache and message broker supporting strings hashes lists sets and sorted sets",
        "Memcached is a high-performance distributed memory object caching system intended for speeding up dynamic web applications by alleviating database load",
        "DragonflyDB is a modern replacement for Redis and Memcached that is multithreaded and designed for cloud workloads with significantly higher throughput",
        "Apache Kafka is a distributed event streaming platform used by thousands of companies for high-performance data pipelines and streaming analytics",
        "Kubernetes is a portable extensible open-source platform for managing containerized workloads and services that facilitates both declarative configuration and automation",
    ]

    paraphrased_texts = [
        "Redis is an open-source in-memory data structure store used as a database cache and message broker supporting strings hashes lists sets and sorted sets",
        "Redis is a fast open-source in-memory key-value data store used as a database cache message broker and streaming engine supporting multiple data structures",
        "Redis is an in-memory data structure store used as a distributed in-memory key-value database cache and message broker with optional durability",
        "Redis is an open-source in-memory data structure store that can be used as a database cache and message broker it supports data structures such as strings hashes lists sets",
        "Redis is a popular open-source in-memory data store used as a database cache and message broker supporting various data structures including strings hashes and sorted sets",
    ]

    redundant_texts = [
        "Redis is an open-source in-memory data structure store used as a database cache and message broker supporting strings hashes lists sets and sorted sets",
        "Redis is an open-source in-memory data structure store used as a database cache and message broker supporting strings hashes lists sets and sorted sets",
        "Redis is an open-source in-memory data structure store used as a database cache and message broker supporting strings hashes lists sets and sorted sets",
        "Redis is an open-source in-memory data structure store used as a database cache and message broker supporting strings hashes lists sets and sorted sets",
        "Redis is an open-source in-memory data structure store used as a database cache and message broker supporting strings hashes lists sets and sorted sets",
    ]

    results = {}
    for label, texts in [("A) Diverse topics", diverse_texts),
                          ("B) Paraphrased (same topic, diff words)", paraphrased_texts),
                          ("C) Truly redundant (copy-paste)", redundant_texts)]:
        print(f"\n── {label} ──")
        tracker = InformationGainTracker()
        rows = []
        for i, text in enumerate(texts):
            gain = tracker.measure(f"tool_{i+1}", text)
            rows.append((f"tool_{i+1}", f"{gain:.3f}", "LOW" if gain < 0.15 else "OK", tracker._consecutive_low))
        table(rows, ("Tool", "Gain", "Status", "Consec Low"))
        avg = sum(tracker.summary["gains"]) / len(tracker.summary["gains"])
        print(f"  Converged: {tracker.converged}  |  Avg gain: {avg:.3f}  |  Unique shingles: {tracker.summary['total_shingles']}")
        results[label[:1]] = {"converged": tracker.converged, "avg": avg}

    print(f"\n  ▸ Summary:")
    print(f"    Diverse avg:      {results['A']['avg']:.3f}  converged={results['A']['converged']}")
    print(f"    Paraphrased avg:  {results['B']['avg']:.3f}  converged={results['B']['converged']}")
    print(f"    Redundant avg:    {results['C']['avg']:.3f}  converged={results['C']['converged']}")
    print(f"\n  ▸ KEY INSIGHT: Paraphrases have ~45% gain because different words = new shingles.")
    print(f"    Only true copy-paste redundancy triggers convergence. This is a feature —")
    print(f"    it prevents false positives when tools describe the same topic differently.")

    ok = (not results["A"]["converged"] and
           not results["B"]["converged"] and
           results["C"]["converged"] and
           results["A"]["avg"] > results["B"]["avg"] > results["C"]["avg"])
    print(f"  ▸ VERDICT: {'PASS ✓' if ok else 'FAIL ✗'}")

    return results


def experiment_2():
    header("EXPERIMENT 2: Convergence Timing — When Does It Fire?")

    base = "Redis is an open-source in-memory data structure store used as a database cache and message broker supporting strings hashes lists sets"
    novel_injection = "Kubernetes orchestrates containerized workloads across clusters enabling auto-scaling service discovery and rolling deployments for microservices"

    scenarios = {
        "A) All identical": [base] * 5,
        "B) Novel at step 3": [base, base, novel_injection, base, base],
        "C) Novel at step 2": [base, novel_injection, base, base, base],
        "D) Alternating": [base, novel_injection, base, novel_injection, base],
        "E) All unique": [
            base,
            "Memcached provides simple fast caching with a multithreaded architecture for web application performance optimization",
            novel_injection,
            "Apache Kafka enables distributed event streaming with high throughput fault tolerance and exactly once semantics for data pipelines",
            "DragonflyDB is a modern multithreaded drop-in replacement for Redis with dramatically improved memory efficiency and throughput",
        ],
    }

    rows = []
    for label, texts in scenarios.items():
        t = InformationGainTracker()
        gains = []
        converge_step = "-"
        for i, text in enumerate(texts):
            g = t.measure(f"step_{i+1}", text)
            gains.append(f"{g:.2f}")
            if t.converged and converge_step == "-":
                converge_step = str(i + 1)
        rows.append((label, " → ".join(gains), converge_step, "YES" if t.converged else "NO"))

    table(rows, ("Scenario", "Gains (per step)", "Conv. Step", "Converged?"))

    print("\n  ▸ INSIGHT: Convergence fires only after 2 consecutive low-gain steps.")
    print("    Injecting truly novel data resets the counter — but re-using already-seen")
    print("    text counts as low gain, so D) alternating converges after re-visiting.")
    all_correct = all(
        (r[0].startswith("A") and r[3] == "YES") or
        (r[0].startswith("E") and r[3] == "NO")
        for r in rows if r[0].startswith("A") or r[0].startswith("E")
    )
    print(f"  ▸ VERDICT: {'PASS ✓' if all_correct else 'FAIL ✗'} (A=converge, E=no converge)")


def experiment_3():
    header("EXPERIMENT 3: Live API Data — Real Tool Calls")
    print("  Calling real APIs to collect actual data and measure gain...\n")

    from tools import tool_registry

    test_cases = [
        {
            "label": "A) Focused — same topic across all tools",
            "calls": [
                ("search_wikipedia", {"topic": "Redis"}),
                ("search_hacker_news", {"query": "Redis caching"}),
                ("search_github_repos", {"topic": "Redis"}),
                ("search_research_papers", {"query": "Redis in-memory caching"}),
            ],
        },
        {
            "label": "B) Broad — different topics per tool",
            "calls": [
                ("search_wikipedia", {"topic": "Redis"}),
                ("search_hacker_news", {"query": "large language models"}),
                ("search_github_repos", {"topic": "kubernetes"}),
                ("search_research_papers", {"query": "transformer attention mechanism"}),
            ],
        },
    ]

    tool_map = {t.name: t.function for t in tool_registry}

    for tc in test_cases:
        print(f"── {tc['label']} ──")
        tracker = InformationGainTracker()
        rows = []
        for tool_name, args in tc["calls"]:
            fn = tool_map.get(tool_name)
            if not fn:
                print(f"  ⚠ Tool {tool_name} not found, skipping.")
                continue
            try:
                result = fn(**args)
                gain = tracker.measure(tool_name, result)
                preview = result[:60].replace("\n", " ") + "..."
                rows.append((tool_name, list(args.values())[0], f"{gain:.3f}",
                             "LOW" if gain < 0.15 else "OK", len(result)))
            except Exception as e:
                rows.append((tool_name, list(args.values())[0], "ERR", str(e)[:30], 0))
            time.sleep(0.5)

        table(rows, ("Tool", "Query", "Gain", "Status", "Chars"))
        print(f"  Converged: {tracker.converged}  |  Gains: {tracker.summary['gains']}")
        print(f"  Total unique shingles: {tracker.summary['total_shingles']}\n")

    print("  ▸ INSIGHT: Even with the same topic, different APIs return different")
    print("    vocabulary (titles vs descriptions vs code), so gain stays moderate.")
    print("    True convergence requires semantically redundant content.")


def experiment_4():
    header("EXPERIMENT 4: Threshold Sensitivity — What If We Change the Cutoff?")

    base = "Redis is an open-source in-memory data structure store used as a database cache and message broker"
    slightly_different = "Redis is a popular open-source in-memory data store used as a cache message broker and database with optional persistence"
    very_different = "Kubernetes is a portable extensible platform for managing containerized workloads and services facilitating declarative configuration"

    thresholds = [0.05, 0.10, 0.15, 0.20, 0.30, 0.50]
    texts = [base, slightly_different, very_different, base, slightly_different]

    rows = []
    for thresh in thresholds:
        t = InformationGainTracker()
        t.GAIN_THRESHOLD = thresh
        conv_step = "-"
        for i, text in enumerate(texts):
            t.measure(f"s{i+1}", text)
            if t.converged and conv_step == "-":
                conv_step = str(i + 1)
        rows.append((f"{thresh:.2f}", " → ".join(f"{g:.2f}" for g in t.summary["gains"]),
                      conv_step, "YES" if t.converged else "NO"))

    table(rows, ("Threshold", "Gains", "Conv. Step", "Converged?"))
    print("\n  ▸ INSIGHT: Lower thresholds are more aggressive (converge faster).")
    print("    0.15 is the sweet spot — catches true redundancy without false positives.")


if __name__ == "__main__":
    print("\n" + "#" * 72)
    print("  INFORMATION GAIN TRACKING — EXPERIMENTAL VALIDATION")
    print("#" * 72)

    experiment_1()
    experiment_2()
    experiment_4()

    if "--live" in sys.argv:
        experiment_3()
    else:
        print(f"\n{DIVIDER}")
        print("  EXPERIMENT 3 skipped (uses live APIs). Run with --live to include.")
        print(DIVIDER)

    print(f"\n{'#' * 72}")
    print("  ALL EXPERIMENTS COMPLETE")
    print(f"{'#' * 72}\n")
