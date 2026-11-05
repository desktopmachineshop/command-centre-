import { describe, expect, it } from "vitest";
import { providerErrorDetail } from "../src/integrations/oauth/routes";

describe("providerErrorDetail", () => {
  it("keeps the provider's error, description and uri on one line", () => {
    const q = new URLSearchParams({
      state: "s",
      error: "unauthorized_client",
      error_description: "AADSTS700016: not enabled for consumers.\r\nTrace ID: abc\r\nCorrelation ID: def",
      error_uri: "https://login.microsoftonline.com/error?code=700016",
    });
    expect(providerErrorDetail(q)).toBe(
      "error=unauthorized_client | error_description=AADSTS700016: not enabled for consumers. Trace ID: abc Correlation ID: def | error_uri=https://login.microsoftonline.com/error?code=700016",
    );
  });

  it("caps long values", () => {
    const q = new URLSearchParams({ error: "x", error_description: "y".repeat(2000) });
    expect(providerErrorDetail(q).length).toBeLessThan(700);
  });
});
