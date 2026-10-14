# AI Conversation Forwarder

[中文](README.md)

Like WeChat's "forward chat history": tick a few messages in one AI chat, copy them in one click, and paste them into another AI.

The receiving AI can tell which AI and which conversation the messages came from, and who said what.

```text
【以下转自 ChatGPT 对话《Organizations and cooperation》，共 3 条】

【我】
A good organization shouldn't depend on everyone being kind.

【ChatGPT】
Good management may not be about making people kinder,
but about letting them choose what's good for the group
without sacrificing their own interests.

【我】
So what kind of rules would make that possible?
```

The labels are currently in Chinese: 【以下转自 … 对话《title》，共 N 条】 means "Forwarded from a … conversation 《title》, N messages", and 【我】 means "Me".

## Why

I often ask different AIs to judge the same question independently. I'll work out an idea in ChatGPT and want Claude's view, or get a good answer in Claude and want to keep discussing it in ChatGPT.

Copying by hand and keeping track of who said what is tedious. Some forwarding tools also summarize or rewrite along the way, but what I want is the original words.

So this tool does one thing: **it moves the original conversation across as it is.** No summarizing, no rewriting, no added prompts.

## Supported sites

| Site | Address |
| --- | --- |
| Claude | claude.ai |
| ChatGPT | chatgpt.com, chat.openai.com |

It works only on the web versions, in a desktop browser such as Chrome or Edge. It does not work in the Claude or ChatGPT desktop or mobile apps.

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. In recent versions of Chrome or Edge, turn on one setting: go to `chrome://extensions` (or `edge://extensions`), open Tampermonkey's **Details**, and turn on **Allow User Scripts**. If you can't find it, turn on **Developer mode** at the top right of the extensions page.
3. Install the script, either way:
   - From Greasy Fork (recommended, updates automatically): *link coming after publication*
   - From this repository: open [ai-conversation-forwarder.user.js](https://github.com/qiduo-lab/ai-conversation-forwarder/raw/main/ai-conversation-forwarder.user.js), and Tampermonkey will show an install page. Click **Install**.
4. Reload the Claude or ChatGPT page.

## Use

1. Open a conversation and click **勾选转发** ("select to forward") at the top right of the page.
2. Click a message, or the small circle to its left, to select it. Click again to deselect. Hold Shift to select a range.
3. Click **复制转发** ("copy to forward") in the bar at the bottom.
4. Paste into another AI's chat box.

Press Esc, or click **取消** ("cancel"), to leave selection mode at any time.

## What gets copied

- The source site and conversation title, added automatically.
- A speaker label before each message, in the original order.
- Line breaks, paragraphs, lists, code blocks, tables and formulas, as far as possible.
- Only the messages you selected, with their text unchanged.
- Things on the page that aren't part of a message are left out: timestamps, button labels, reasoning summaries such as "Thought for 8 seconds", and hidden screen-reader text.

## Privacy

- Everything happens in your own browser.
- The script **makes no network requests**. It does not collect or upload any conversation content, and contains no analytics.
- It uses three Tampermonkey permissions only: writing to the clipboard (`GM_setClipboard`), adding its own styles (`GM_addStyle`), and adding items to the Tampermonkey menu (`GM_registerMenuCommand`).
- The code is fully readable, with no minification or obfuscation.

## Known limits

- **Attachments are not included.** The contents of images, PDFs and other attachments live on the AI site's servers, and the page only shows a card for them. Drag the original file into the new conversation if you need it.
- **Site redesigns can break it.** Claude and ChatGPT change their pages from time to time. If you see "没找到消息" ("no messages found"), see below.

## Reporting a problem

1. On the page where it fails, click the Tampermonkey icon and choose **复制诊断信息（不含对话内容）** ("copy diagnostics, no conversation content").
2. Open an [issue](https://github.com/qiduo-lab/ai-conversation-forwarder/issues), paste the diagnostics, and say which site and what happened.

The diagnostics contain only page structure, element names and character counts, **never any conversation text**.

## How the code is organized

The script is a single file with two layers:

- **Site adapters**: a small section per site that finds the user messages and AI replies, reads the conversation title, and picks out the main text of each reply.
- **Shared part**: the selection interface, the bottom bar, turning page content into text, and copying to the clipboard.

Supporting a new site (such as Gemini or DeepSeek) only needs a new adapter. Contributions are welcome.

## Author

七朵 / Qiduo. More of my work: [github.com/qiduo-lab](https://github.com/qiduo-lab).

## License

[MIT](LICENSE)
