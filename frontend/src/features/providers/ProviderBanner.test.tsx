import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { azureDisclosure } from "../../lib/providers";
import { ProviderBanner } from "./ProviderBanner";

afterEach(cleanup);

const ALL_MOCK = { translation: "mock", speech: "mock", audio: "mock" };
const AZURE_TRANSLATION = {
  translation: "azure",
  speech: "mock",
  audio: "mock",
};
const AZURE_BOTH = { translation: "azure", speech: "azure", audio: "mock" };
const MOCK_TRANSLATION_REAL_SPEECH = {
  translation: "mock",
  speech: "azure",
  audio: "mock",
};
const MOCK_TRANSLATION_ADJUSTED = {
  translation: "mock",
  speech: "azure",
  audio: "ffmpeg",
};

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
    expect(banner.textContent).toContain(
      "Audio processing: mock (pass-through: duration not adjusted)",
    );
    expect(banner.textContent).toContain("fixed sample");
  });

  it("never claims that no Azure service is called when translation uses Azure", () => {
    render(<ProviderBanner providers={AZURE_TRANSLATION} />);
    expect(screen.queryByText(/No Azure services are called/)).toBeNull();
    expect(screen.queryByText(/Development mock mode/)).toBeNull();
  });

  it("real translation and real speech: says so and that the duration is not adjusted", () => {
    render(<ProviderBanner providers={AZURE_BOTH} />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain(
      "Beta: real translation and speech, duration not adjusted.",
    );
    expect(banner.textContent).toContain("Translation: Azure Translator (real)");
    expect(banner.textContent).toContain("Speech: Azure Speech (real)");
    expect(banner.textContent).toContain("Audio processing: mock (pass-through");
    // Nothing here is a fixture any more.
    expect(banner.textContent).not.toContain("fixed sample");
    expect(banner.textContent).not.toContain("No Azure services are called");
    expect(banner.textContent).not.toContain("Speech: mock");
  });

  it("mock translation with real speech labels each component", () => {
    render(<ProviderBanner providers={MOCK_TRANSLATION_REAL_SPEECH} />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Beta: mock translation, real speech.");
    expect(banner.textContent).toContain("Translation: mock (placeholder)");
    expect(banner.textContent).toContain("Speech: Azure Speech (real)");
    expect(banner.textContent).not.toContain("No Azure services are called");
  });

  it("mock translation with real, duration-adjusted audio no longer says it is not adjusted", () => {
    render(<ProviderBanner providers={MOCK_TRANSLATION_ADJUSTED} />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Beta: mock translation, real speech, duration adjusted.");
    expect(banner.textContent).toContain("Translation: mock (placeholder)");
    expect(banner.textContent).toContain("Audio processing: FFmpeg (real)");
    expect(banner.textContent).not.toContain("not adjusted");
    expect(banner.textContent).not.toContain("pass-through");
  });

  it("shows nothing when every component is real", () => {
    const { container } = render(
      <ProviderBanner providers={{ translation: "azure", speech: "azure", audio: "ffmpeg" }} />,
    );
    expect(container.innerHTML).toBe("");
  });
});

describe("azureDisclosure", () => {
  it("is empty when nothing is sent to Azure", () => {
    expect(azureDisclosure(ALL_MOCK)).toBeNull();
  });

  it("names Azure Translator when only translation is real", () => {
    const text = azureDisclosure(AZURE_TRANSLATION) ?? "";
    expect(text).toContain("transcript text is sent to Microsoft Azure Translator");
    expect(text).not.toContain("Azure Speech");
  });

  it("names both services when translation and speech are real", () => {
    const text = azureDisclosure(AZURE_BOTH) ?? "";
    expect(text).toContain("transcript text is sent to Microsoft Azure Translator");
    expect(text).toContain("translated Vietnamese text is sent to Microsoft Azure Speech");
  });

  it("says that the placeholder still contains the transcript when only speech is real", () => {
    const text = azureDisclosure(MOCK_TRANSLATION_REAL_SPEECH) ?? "";
    expect(text).toContain("Microsoft Azure Speech");
    expect(text).toContain("still contains your transcript text");
    expect(text).not.toContain("Azure Translator");
  });
});
