import { describe, expect, it } from "vitest";
import { githubIssueAccess } from "../src/code";

const REPO = "desktopmachineshop/command-centre-";

describe("githubIssueAccess: a refused issue write says what GitHub said", () => {
  it("names the action, GitHub's reason and the permission it wanted", () => {
    const why = githubIssueAccess({ status: 403, json: { message: "Resource not accessible by personal access token" }, accepted: "issues=write; pull_requests=write" }, REPO, "comment on #115");
    expect(why).toContain(`may not comment on #115 on ${REPO}`);
    expect(why).toContain("Resource not accessible by personal access token");
    expect(why).toContain("GitHub wanted: issues=write; pull_requests=write.");
  });

  it("still reads sensibly without GitHub's details", () => {
    expect(githubIssueAccess({ status: 403, json: {} }, REPO, "create issues")).toMatch(/^GITHUB_TOKEN may not create issues on .+ \(403\)\. Check/);
  });

  it("tells a dead token apart", () => {
    expect(githubIssueAccess({ status: 401, json: {} }, REPO, "create issues")).toContain("401");
  });
});
