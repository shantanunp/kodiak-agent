import { Octokit } from "@octokit/rest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getEnvOptional } from "../config/env.js";

export interface FileContent {
  path: string;
  content: string;
  sha: string;
}

export class GitHubClient {
  private octokit: Octokit;
  private mcp: Client | null = null;
  readonly authenticated: boolean;

  constructor(token?: string) {
    const resolved = token ?? getEnvOptional("GITHUB_TOKEN");
    this.authenticated = !!resolved;
    // Public repos work without a token (60 req/hr). Set GITHUB_TOKEN for 5000/hr.
    this.octokit = new Octokit(resolved ? { auth: resolved } : {});
  }

  async connectMcp(): Promise<void> {
    if (this.mcp) return;

    const command = getEnvOptional("GITHUB_MCP_COMMAND", "github-mcp-server");
    const token = getEnvOptional("GITHUB_TOKEN");

    try {
      const transport = new StdioClientTransport({
        command,
        args: [
          "--read-only",
          "--tools",
          "get_file_contents,list_commits,get_commit,search_code",
        ],
        env: {
          ...process.env,
          GITHUB_PERSONAL_ACCESS_TOKEN: token,
        } as Record<string, string>,
      });

      const client = new Client({ name: "kodiak-agent", version: "0.1.0" });
      await client.connect(transport);
      this.mcp = client;
    } catch {
      this.mcp = null;
    }
  }

  async disconnectMcp(): Promise<void> {
    if (this.mcp) {
      await this.mcp.close();
      this.mcp = null;
    }
  }

  async getLatestCommitSha(owner: string, repo: string, branch: string): Promise<string> {
    if (this.mcp) {
      try {
        const result = await this.mcp.callTool({
          name: "list_commits",
          arguments: {
            owner,
            repo,
            sha: branch,
            perPage: 1,
            fields: ["sha"],
          },
        });
        const text = extractText(result);
        const parsed = JSON.parse(text) as { sha?: string }[] | { commits?: { sha: string }[] };
        if (Array.isArray(parsed) && parsed[0]?.sha) return parsed[0].sha;
        if ("commits" in parsed && parsed.commits?.[0]?.sha) return parsed.commits[0].sha;
      } catch {
        // fall through to REST
      }
    }

    const { data } = await this.octokit.repos.listCommits({
      owner,
      repo,
      sha: branch,
      per_page: 1,
    });
    if (!data[0]?.sha) {
      throw new Error(`No commits found for ${owner}/${repo}@${branch}`);
    }
    return data[0].sha;
  }

  async getFileContents(
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<FileContent> {
    if (this.mcp) {
      try {
        const result = await this.mcp.callTool({
          name: "get_file_contents",
          arguments: { owner, repo, path, ref },
        });
        const text = extractText(result);
        const parsed = JSON.parse(text) as {
          content?: string;
          sha?: string;
          encoding?: string;
        };
        const content =
          parsed.encoding === "base64" && parsed.content
            ? Buffer.from(parsed.content, "base64").toString("utf8")
            : (parsed.content ?? text);
        return { path, content, sha: parsed.sha ?? ref };
      } catch {
        // fall through to REST
      }
    }

    const { data } = await this.octokit.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data) || data.type !== "file") {
      throw new Error(`Path is not a file: ${path}`);
    }
    const content = Buffer.from(data.content, data.encoding as BufferEncoding).toString("utf8");
    return { path, content, sha: data.sha };
  }

  async diffFiles(
    owner: string,
    repo: string,
    baseSha: string,
    headSha: string,
  ): Promise<string[]> {
    const { data } = await this.octokit.repos.compareCommits({
      owner,
      repo,
      base: baseSha,
      head: headSha,
    });
    return (data.files ?? []).map((f) => f.filename).filter(Boolean) as string[];
  }

  async searchCode(owner: string, repo: string, query: string): Promise<string[]> {
    const q = `${query} repo:${owner}/${repo}`;
    const { data } = await this.octokit.search.code({ q, per_page: 30 });
    return data.items.map((item) => item.path);
  }
}

function extractText(result: { content?: Array<{ type: string; text?: string }> }): string {
  const parts = result.content ?? [];
  return parts
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!)
    .join("\n");
}
