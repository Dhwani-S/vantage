"""
Unit tests for InformationGainTracker.
Validates shingle computation, gain measurement, and convergence logic.
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import unittest
from convergence import InformationGainTracker


class TestShingle(unittest.TestCase):
    """Verify the _shingle static method."""

    def test_basic_shingles(self):
        shingles = InformationGainTracker._shingle("the cat sat on the mat", n=3)
        expected = {
            ("the", "cat", "sat"),
            ("cat", "sat", "on"),
            ("sat", "on", "the"),
            ("on", "the", "mat"),
        }
        self.assertEqual(shingles, expected)

    def test_short_text(self):
        self.assertEqual(
            InformationGainTracker._shingle("hello world", n=3),
            {("hello", "world")}
        )

    def test_empty_text(self):
        self.assertEqual(InformationGainTracker._shingle("", n=3), set())

    def test_punctuation_ignored(self):
        s1 = InformationGainTracker._shingle("hello, world! foo", n=3)
        s2 = InformationGainTracker._shingle("hello world foo", n=3)
        self.assertEqual(s1, s2)

    def test_case_insensitive(self):
        s1 = InformationGainTracker._shingle("Redis Caching Layer", n=3)
        s2 = InformationGainTracker._shingle("redis caching layer", n=3)
        self.assertEqual(s1, s2)


class TestGainMeasurement(unittest.TestCase):

    def test_first_call_always_100(self):
        t = InformationGainTracker()
        gain = t.measure("tool_a", "Redis is a fast in-memory data store used for caching")
        self.assertAlmostEqual(gain, 1.0)

    def test_identical_text_gives_zero(self):
        t = InformationGainTracker()
        text = "Redis is a fast in-memory data store used for caching"
        t.measure("tool_a", text)
        gain2 = t.measure("tool_b", text)
        self.assertAlmostEqual(gain2, 0.0)

    def test_completely_new_text_gives_high_gain(self):
        t = InformationGainTracker()
        t.measure("tool_a", "Redis is a fast in-memory data store used for caching")
        gain = t.measure("tool_b", "Python decorators provide syntactic sugar for higher order functions")
        self.assertGreater(gain, 0.9)

    def test_partial_overlap(self):
        t = InformationGainTracker()
        t.measure("tool_a", "Redis is a fast in-memory data store used for caching")
        gain = t.measure("tool_b", "Redis is a fast key-value database with pub-sub support")
        self.assertGreater(gain, 0.3)
        self.assertLess(gain, 0.9)

    def test_gains_accumulate(self):
        t = InformationGainTracker()
        t.measure("a", "alpha beta gamma delta epsilon")
        t.measure("b", "zeta eta theta iota kappa")
        t.measure("c", "lambda mu nu xi omicron")
        self.assertEqual(len(t.summary["gains"]), 3)
        self.assertEqual(t.summary["total_shingles"], 9)


class TestConvergence(unittest.TestCase):

    def test_no_convergence_on_diverse_data(self):
        t = InformationGainTracker()
        t.measure("a", "Redis is a fast in-memory data store")
        t.measure("b", "Python decorators provide syntactic sugar")
        t.measure("c", "Kubernetes orchestrates containerized workloads")
        self.assertFalse(t.converged)

    def test_convergence_on_repeated_data(self):
        t = InformationGainTracker()
        text = "Redis is a fast in-memory data store used for caching in distributed systems"
        t.measure("a", text)
        t.measure("b", text)
        t.measure("c", text)
        self.assertTrue(t.converged)

    def test_convergence_resets_on_novel_data(self):
        t = InformationGainTracker()
        text = "Redis is a fast in-memory data store used for caching"
        t.measure("a", text)
        t.measure("b", text)
        t.measure("c", "Completely different topic about machine learning and neural networks")
        self.assertFalse(t.converged)
        self.assertEqual(t._consecutive_low, 0)

    def test_summary_dict(self):
        t = InformationGainTracker()
        t.measure("a", "hello world foo bar baz")
        s = t.summary
        self.assertIn("gains", s)
        self.assertIn("total_shingles", s)
        self.assertIn("converged", s)
        self.assertIn("consecutive_low", s)


if __name__ == "__main__":
    unittest.main()
