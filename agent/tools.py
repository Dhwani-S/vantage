import requests
import warnings
from models import ToolDefinition

warnings.filterwarnings("ignore", category=UserWarning, module="wikipedia")

tool_registry: list[ToolDefinition] = []

def tool(name: str, description: str, parameters: dict):
    def decorator(func):
        tool_registry.append(ToolDefinition(
            name=name,
            description=description,
            parameters=parameters,
            function=func))
        return func
    return decorator


@tool(
    name="search_wikipedia",
    description="Fetches official background context from Wikipedia for a given topic.",
    parameters={"topic": {"type": "string", "description": "The topic to search on Wikipedia"}}
)
def search_wikipedia(topic: str) -> str:
    """Fetches official background context from Wikipedia."""
    import wikipedia
    try:
        results = wikipedia.search(topic, results=3)
        if not results:
            return f"No Wikipedia articles found for '{topic}'."

        summaries = []
        for title in results:
            try:
                page = wikipedia.page(title, auto_suggest=False)
                summary = page.summary[:300] + "..." if len(page.summary) > 300 else page.summary
                summaries.append(f"**{page.title}**: {summary}")
            except (wikipedia.DisambiguationError, wikipedia.PageError):
                continue

        return "\n\n".join(summaries) if summaries else f"No summaries found for '{topic}'."
    except Exception as e:
        return f"Error fetching Wikipedia data: {str(e)}"


@tool(
    name="search_hacker_news",
    description="Searches Hacker News for developer discussions, sentiment, and community opinions on a topic.",
    parameters={"query": {"type": "string", "description": "The search query to find discussions on Hacker News"}}
)
def search_hacker_news(query: str) -> str:
    """Searches Hacker News for developer sentiment."""
    try:
        res = requests.get(
            "https://hn.algolia.com/api/v1/search",
            params={"query": query, "hitsPerPage": 5, "tags": "story"}
        )
        if res.status_code != 200:
            return "Error from Hacker News API."

        hits = res.json().get("hits", [])
        if not hits:
            return f"No Hacker News discussions found for '{query}'."

        results = []
        for h in hits:
            title = h.get("title", "Untitled")
            points = h.get("points", 0)
            comments = h.get("num_comments", 0)
            url = h.get("url", "")
            results.append(f"- {title} ({points} points, {comments} comments) {url}")

        return "\n".join(results)
    except Exception as e:
        return f"Error searching Hacker News: {str(e)}"


@tool(
    name="search_github_repos",
    description="Searches GitHub for popular open-source repositories related to a topic, sorted by stars.",
    parameters={"topic": {"type": "string", "description": "The topic to search GitHub repositories for"}}
)
def search_github_repos(topic: str) -> str:
    """Searches GitHub for open-source popularity."""
    try:
        res = requests.get(
            "https://api.github.com/search/repositories",
            params={"q": topic, "sort": "stars", "order": "desc", "per_page": 5}
        )
        if res.status_code != 200:
            return "Error from GitHub API."

        items = res.json().get("items", [])
        if not items:
            return f"No GitHub repositories found for '{topic}'."

        results = []
        for repo in items:
            name = repo.get("full_name", "")
            stars = repo.get("stargazers_count", 0)
            desc = repo.get("description", "No description") or "No description"
            lang = repo.get("language", "N/A") or "N/A"
            results.append(f"- {name} (stars: {stars}, lang: {lang}) -- {desc}")

        return "\n".join(results)
    except Exception as e:
        return f"Error searching GitHub: {str(e)}"


@tool(
    name="search_research_papers",
    description="Searches OpenAlex for foundational academic and research papers on a topic.",
    parameters={"query": {"type": "string", "description": "The search query to find academic papers"}}
)
def search_research_papers(query: str) -> str:
    """Searches OpenAlex for foundational academic papers."""
    try:
        res = requests.get(
            "https://api.openalex.org/works",
            params={"search": query, "per-page": 5, "sort": "cited_by_count:desc"}
        )
        if res.status_code != 200:
            return "Error from OpenAlex API."

        papers = res.json().get("results", [])
        if not papers:
            return f"No research papers found for '{query}'."

        results = []
        for p in papers:
            title = p.get("title", "Untitled")
            year = p.get("publication_year", "N/A")
            citations = p.get("cited_by_count", 0)
            results.append(f"- {title} (Year: {year}, Citations: {citations})")

        return "\n".join(results)
    except Exception as e:
        return f"Error searching papers: {str(e)}"
