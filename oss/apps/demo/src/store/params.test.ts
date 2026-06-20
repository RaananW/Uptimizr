import { describe, expect, it } from "vitest";
import { toPositionalQuery } from "./params.js";

describe("toPositionalQuery", () => {
  it("rewrites a single named placeholder to $1 and collects its value", () => {
    const { sql, values } = toPositionalQuery({
      query: "SELECT * FROM events WHERE project_id = $projectId",
      query_params: { projectId: "demo" },
    });
    expect(sql).toBe("SELECT * FROM events WHERE project_id = $1");
    expect(values).toEqual(["demo"]);
  });

  it("assigns indices in first-appearance order across distinct names", () => {
    const { sql, values } = toPositionalQuery({
      query: "WHERE project_id = $projectId AND ts >= $since::TIMESTAMP AND ts < $until::TIMESTAMP",
      query_params: { projectId: "demo", since: "2024-01-01 00:00:00.000", until: "2024-01-02 00:00:00.000" },
    });
    expect(sql).toBe("WHERE project_id = $1 AND ts >= $2::TIMESTAMP AND ts < $3::TIMESTAMP");
    expect(values).toEqual(["demo", "2024-01-01 00:00:00.000", "2024-01-02 00:00:00.000"]);
  });

  it("reuses the same $N for a repeated name and binds its value once", () => {
    const { sql, values } = toPositionalQuery({
      query: "SELECT $bins, floor(x / $bins) FROM t WHERE project_id = $projectId",
      query_params: { bins: 10, projectId: "demo" },
    });
    expect(sql).toBe("SELECT $1, floor(x / $1) FROM t WHERE project_id = $2");
    expect(values).toEqual([10, "demo"]);
  });

  it("does not treat a JSON path ('$.a.b') as a placeholder", () => {
    const { sql, values } = toPositionalQuery({
      query:
        "SELECT json_extract_string(payload, '$.scene.cameraType') AS c FROM events WHERE project_id = $projectId",
      query_params: { projectId: "demo" },
    });
    expect(sql).toBe(
      "SELECT json_extract_string(payload, '$.scene.cameraType') AS c FROM events WHERE project_id = $1",
    );
    expect(values).toEqual(["demo"]);
  });

  it("binds a missing param key as null rather than undefined", () => {
    const { values } = toPositionalQuery({
      query: "WHERE a = $missing",
      query_params: {},
    });
    expect(values).toEqual([null]);
  });

  it("returns no values for a parameterless query", () => {
    const { sql, values } = toPositionalQuery({
      query: "SELECT DISTINCT scene_id FROM events",
      query_params: {},
    });
    expect(sql).toBe("SELECT DISTINCT scene_id FROM events");
    expect(values).toEqual([]);
  });
});
