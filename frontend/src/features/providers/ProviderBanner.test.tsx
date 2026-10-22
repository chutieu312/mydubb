import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { sendsTranscriptToAzure } from "../../lib/providers";
import { ProviderBanner } from "./ProviderBanner";

afterEach(cleanup);

const ALL_MOCK = { translation: "mock", speech: "mock", audio: "mock" };
const AZURE_TRANSLATION = { translation: "azure", speech: "mock", audio: "mock" };

describe("ProviderBanner", () => {
  it("labels everything as mock when no component is real", () => {
    render(<ProviderBanner providers={ALL_MOCK} />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Development mock mode.");
    expect(banner.textContent).toContain("No Azure services are called");
  });

  it("labels each component when translation is real and audio is mock", () => {
    render(<ProviderBanner providers={AZURE_TRANSLATION} />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Beta: real translation, mock audio.");
    expect(banner.textContent).toContain("Translation: Azure Translator (real)");
    expect(banner.textContent).toContain("Speech: mock (placeholder)");
    expect(banner.textContent).toContain("Audio processing: mock (placeholder)");
    expect(banner.textContent).toContain("fixed sample");
  });

  it("never claims that no Azure service is called when translation uses Azure", () => {
    render(<ProviderBanner providers={AZURE_TRANSLATION} />);
    expect(screen.queryByText(/No Azure services are called/)).toBeNull();
    expect(screen.queryByText(/Development mock mode/)).toBeNull();
  });

  it("shows nothing when every component is real", () => {
    const { container } = render(
      <ProviderBanner providers={{ translation: "azure", speech: "azure", audio: "ffmpeg" }} />,
    );
    expect(container.innerHTML).toBe("");
  });
});

describe("sendsTranscriptToAzure", () => {
  it("is true only when translation uses Azure", () => {
    expect(sendsTranscriptToAzure(ALL_MOCK)).toBe(false);
    expect(sendsTranscriptToAzure(AZURE_TRANSLATION)).toBe(true);
  });
});
