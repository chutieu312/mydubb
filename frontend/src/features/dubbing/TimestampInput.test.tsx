import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { TimestampInput } from "./TimestampInput";

afterEach(cleanup);

// The real field in a real DOM: every test types, pastes or deletes through user-event, which
// dispatches the same beforeinput/input events (inputType, data, selection) a browser does.
function Harness({ initial = "", error }: { initial?: string; error?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <TimestampInput id="ts" label="Start Time" value={value} onChange={setValue} error={error} />
  );
}

function setup(initial = "", error?: string) {
  render(<Harness initial={initial} error={error} />);
  const input = screen.getByLabelText("Start Time") as HTMLInputElement;
  return { input, user: userEvent.setup() };
}

/** Focus the field and put the caret (or a selection) where the test wants it. */
function select(input: HTMLInputElement, start: number, end = start) {
  input.focus();
  input.setSelectionRange(start, end);
}

const caret = (input: HTMLInputElement) => [input.selectionStart, input.selectionEnd];

describe("typing digits", () => {
  it("adds the colons while the user types and completes nothing", async () => {
    const { input, user } = setup();
    const shown: string[] = [];
    for (const digit of "000001") {
      await user.type(input, digit);
      shown.push(input.value);
    }
    expect(shown).toEqual(["0", "00", "00:0", "00:00", "00:00:0", "00:00:01"]);
  });

  it.each([
    ["000001", "00:00:01"],
    ["000030", "00:00:30"],
    ["010530", "01:05:30"],
    ["1", "1"],
    ["12345", "12:34:5"],
  ])("turns %s into %s", async (typed, expected) => {
    const { input, user } = setup();
    await user.type(input, typed);
    expect(input.value).toBe(expected);
  });

  it("keeps the order of the digits that were typed", async () => {
    const { input, user } = setup();
    await user.type(input, "123456");
    expect(input.value).toBe("12:34:56");
  });

  it("still accepts a timestamp typed with its colons", async () => {
    const { input, user } = setup();
    await user.type(input, "00:06:10");
    expect(input.value).toBe("00:06:10");
    expect(caret(input)).toEqual([8, 8]);
  });

  it("keeps the caret at the end while typing at the end", async () => {
    const { input, user } = setup();
    await user.type(input, "0000");
    expect(input.value).toBe("00:00");
    expect(caret(input)).toEqual([5, 5]);
  });

  it("is a text field with a numeric keyboard, not type=number", () => {
    const { input } = setup();
    expect(input.type).toBe("text");
    expect(input.inputMode).toBe("numeric");
    expect(input.placeholder).toBe("HH:MM:SS");
  });
});

describe("keys the field does not accept", () => {
  it("ignores letters and keeps the caret where it was", async () => {
    const { input, user } = setup("00:00");
    select(input, 1);
    await user.keyboard("a");
    expect(input.value).toBe("00:00");
    expect(caret(input)).toEqual([1, 1]);
  });

  it("ignores a seventh digit", async () => {
    const { input, user } = setup("00:00:01");
    select(input, 8);
    await user.keyboard("5");
    expect(input.value).toBe("00:00:01");
    expect(caret(input)).toEqual([8, 8]);
  });

  it("ignores a seventh digit typed in the middle", async () => {
    const { input, user } = setup("12:34:56");
    select(input, 4);
    await user.keyboard("9");
    expect(input.value).toBe("12:34:56");
    expect(caret(input)).toEqual([4, 4]);
  });

  it("does not let a typed colon shift anything", async () => {
    const { input, user } = setup("12:34");
    select(input, 1);
    await user.keyboard(":");
    expect(input.value).toBe("12:34");
    expect(caret(input)).toEqual([1, 1]);
  });
});

describe("Backspace and Delete next to a colon", () => {
  it("Backspace right after a colon deletes the digit before it", async () => {
    const { input, user } = setup("00:12");
    select(input, 3);
    await user.keyboard("{Backspace}");
    expect(input.value).toBe("01:2");
    expect(caret(input)).toEqual([1, 1]);
  });

  it("Delete right before a colon deletes the digit after it", async () => {
    const { input, user } = setup("12:34");
    select(input, 2);
    await user.keyboard("{Delete}");
    expect(input.value).toBe("12:4");
    expect(caret(input)).toEqual([2, 2]);
  });

  it("Backspace can empty a full timestamp, one digit at a time", async () => {
    const { input, user } = setup("01:05:30");
    select(input, 8);
    const shown: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      await user.keyboard("{Backspace}");
      shown.push(input.value);
    }
    expect(shown).toEqual(["01:05:3", "01:05", "01:0", "01", "0", ""]);
  });

  it("never gets stuck on a colon when deleting backwards from the middle", async () => {
    const { input, user } = setup("12:34:56");
    select(input, 6);
    const shown: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      await user.keyboard("{Backspace}");
      shown.push(`${input.value}@${input.selectionStart}`);
    }
    expect(shown).toEqual(["12:35:6@4", "12:56@2", "15:6@1"]);
  });

  it("Delete forwards removes every digit of the rest, one per press", async () => {
    const { input, user } = setup("12:34:56");
    select(input, 0);
    for (let i = 0; i < 6; i += 1) await user.keyboard("{Delete}");
    expect(input.value).toBe("");
  });
});

describe("editing in the middle", () => {
  it("inserts a digit at the caret and keeps the caret after it", async () => {
    const { input, user } = setup("12:56");
    select(input, 2);
    await user.keyboard("3");
    expect(input.value).toBe("12:35:6");
    expect(caret(input)).toEqual([4, 4]);
  });

  it("continues typing from where the caret is after an edit in the middle", async () => {
    const { input, user } = setup("1256");
    select(input, 2);
    await user.keyboard("34");
    expect(input.value).toBe("12:34:56");
    expect(caret(input)).toEqual([5, 5]);
  });

  it("deletes with Backspace in the middle without moving the caret to the end", async () => {
    const { input, user } = setup("12:34:56");
    select(input, 7);
    await user.keyboard("{Backspace}");
    expect(input.value).toBe("12:34:6");
    // Right after the fourth digit, where the deleted digit used to be: not at the end.
    expect(caret(input)).toEqual([5, 5]);
  });

  it("replaces a selection with the typed digit", async () => {
    const { input, user } = setup("12:34:56");
    select(input, 3, 5);
    await user.keyboard("9");
    expect(input.value).toBe("12:95:6");
    expect(caret(input)).toEqual([4, 4]);
  });

  it("replaces everything when all of it is selected", async () => {
    const { input, user } = setup("12:34:56");
    select(input, 0, 8);
    await user.keyboard("7");
    expect(input.value).toBe("7");
    expect(caret(input)).toEqual([1, 1]);
  });

  it("deletes a selection that spans a colon", async () => {
    const { input, user } = setup("12:34:56");
    select(input, 1, 4);
    await user.keyboard("{Backspace}");
    expect(input.value).toBe("14:56");
    expect(caret(input)).toEqual([1, 1]);
  });
});

describe("paste", () => {
  it("accepts six digits and the colon format", async () => {
    const { input, user } = setup();
    await user.click(input);
    await user.paste("000001");
    expect(input.value).toBe("00:00:01");

    select(input, 0, input.value.length);
    await user.paste("00:00:01");
    expect(input.value).toBe("00:00:01");

    select(input, 0, input.value.length);
    await user.paste("010530");
    expect(input.value).toBe("01:05:30");
  });

  it("ignores spaces and a line break around the pasted timestamp", async () => {
    const { input, user } = setup();
    await user.click(input);
    await user.paste(" 00:06:10\n");
    expect(input.value).toBe("00:06:10");
  });

  it("does not complete a short paste", async () => {
    const { input, user } = setup();
    await user.click(input);
    await user.paste("00000");
    expect(input.value).toBe("00:00:0");
  });

  it("keeps hours with more than two digits exactly as pasted", async () => {
    const { input, user } = setup();
    await user.click(input);
    await user.paste("100:05:30");
    expect(input.value).toBe("100:05:30");
  });

  it.each([
    ["seven digits with no colons", "0000001"],
    ["colons in the wrong places", "1:02:03"],
    ["letters around a timestamp", "abc00:00:01"],
    ["a different separator", "00.00.01"],
    ["too many groups", "00:00:00:01"],
  ])("keeps %s as it is instead of making it a timestamp", async (_name, pasted) => {
    const { input, user } = setup();
    await user.click(input);
    await user.paste(pasted);
    expect(input.value).toBe(pasted);
  });
});

describe("hours with more than two digits", () => {
  it("allows a digit typed into the hours of a complete timestamp", async () => {
    const { input, user } = setup("10:00:00");
    select(input, 2);
    await user.keyboard("5");
    expect(input.value).toBe("105:00:00");
    expect(caret(input)).toEqual([3, 3]);
  });

  it("keeps a long-hours timestamp while a digit is edited in the hours", async () => {
    const { input, user } = setup("100:05:30");
    select(input, 3);
    await user.keyboard("{Backspace}");
    expect(input.value).toBe("10:05:30");
  });

  it("edits a long-hours timestamp as typed, without shifting its digits", async () => {
    const { input, user } = setup("100:05:30");
    select(input, 6);
    await user.keyboard("{Backspace}");
    // The minutes lost a digit; nothing was moved around to make it look valid.
    expect(input.value).toBe("100:0:30");
  });

  it("formats again once the user starts over with digits", async () => {
    const { input, user } = setup("100:05:30");
    select(input, 0, input.value.length);
    await user.keyboard("{Backspace}");
    await user.type(input, "000130");
    expect(input.value).toBe("00:01:30");
  });
});

describe("accessibility", () => {
  it("keeps the label, a hint and the error tied to the field", () => {
    const { input } = setup("00:00:0", "Timestamp must use the HH:MM:SS format.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const described = (input.getAttribute("aria-describedby") ?? "").split(" ");
    const texts = described.map((id) => document.getElementById(id)?.textContent ?? "");
    expect(texts[0]).toContain("colons are added automatically");
    expect(texts[1]).toBe("Timestamp must use the HH:MM:SS format.");
  });

  it("has only the hint when there is no error", () => {
    const { input } = setup();
    expect(input.getAttribute("aria-invalid")).toBe("false");
    expect(input.getAttribute("aria-describedby")).toBe("ts-hint");
  });
});
