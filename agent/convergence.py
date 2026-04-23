import re
from logger import log


class InformationGainTracker:
    """Tracks information gain across tool calls using n-gram overlap."""

    GAIN_THRESHOLD = 0.15        # below this = low gain
    CONSECUTIVE_LOW_LIMIT = 2    # converge after N consecutive low-gain calls
    SHINGLE_SIZE = 3             # word-level n-gram size

    def __init__(self):
        self._seen_shingles: set[tuple] = set()
        self._gains: list[float] = []
        self._consecutive_low = 0
        self.converged = False

    @staticmethod
    def _shingle(text: str, n: int = 3) -> set[tuple]:
        """Convert text into a set of word-level n-grams (shingles)."""
        words = re.findall(r'\w+', text.lower())
        if len(words) < n:
            return {tuple(words)} if words else set()
        return {tuple(words[i:i+n]) for i in range(len(words) - n + 1)}

    def measure(self, tool_name: str, result: str) -> float:
        """Compute information gain ratio for a new tool result.
        Returns a float in [0, 1] where 1 = entirely new information."""
        new_shingles = self._shingle(result, self.SHINGLE_SIZE)
        if not new_shingles:
            self._gains.append(0.0)
            self._consecutive_low += 1
            self._check_convergence()
            return 0.0

        novel = new_shingles - self._seen_shingles
        gain = len(novel) / len(new_shingles)

        self._seen_shingles |= new_shingles
        self._gains.append(gain)

        if gain < self.GAIN_THRESHOLD:
            self._consecutive_low += 1
        else:
            self._consecutive_low = 0

        self._check_convergence()

        log("INFO", f"Information gain: {gain:.2f} "
            f"({len(novel)}/{len(new_shingles)} novel shingles) "
            f"[consecutive_low={self._consecutive_low}]",
            data={"tool": tool_name, "gain": f"{gain:.3f}",
                  "threshold": str(self.GAIN_THRESHOLD),
                  "converged": str(self.converged)})
        return gain

    def _check_convergence(self):
        if self._consecutive_low >= self.CONSECUTIVE_LOW_LIMIT:
            self.converged = True

    @property
    def summary(self) -> dict:
        return {
            "gains": [round(g, 3) for g in self._gains],
            "total_shingles": len(self._seen_shingles),
            "converged": self.converged,
            "consecutive_low": self._consecutive_low,
        }


CONVERGENCE_NUDGE = ("You have gathered enough information — the last tool calls returned mostly "
                     "redundant data. Please synthesize your findings into a comprehensive final answer now.")
