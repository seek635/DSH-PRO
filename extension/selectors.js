'use strict';
// DSH PRO - selectors.js
// DeepSeek 网页没有公开 DOM 契约，改版会破坏选择器。
// 这里维护每个目标的启发式候选（按序尝试，取第一个命中）。
// 用户可在面板"设置"里粘贴自定义选择器覆盖内置候选（存 chrome.storage.local）。
// 改版适配指引见 README.md「页面改版怎么办」。

var DSHPRO_SELECTORS = {
  // AI 回复的 markdown 容器（从这些容器提取工具调用标记）
  assistantMarkdown: [
    'div.ds-markdown',
    'div[class*="markdown"]',
    'div[class*="message-content"] div[class*="content"]',
  ],
  // 消息列表容器（观察目标；找不到就退化为 document.body）
  messageContainer: [
    'div[class*="chat-container"]',
    'div[class*="message-list"]',
    'main [class*="scroll"]',
  ],
  // 输入框：DeepSeek 是富文本编辑器（contenteditable）或 textarea
  input: [
    'textarea#chat-input',
    'textarea[id*="chat"]',
    'div[contenteditable="true"]',
    'textarea[placeholder]',
  ],
  // 发送按钮
  sendButton: [
    'div[class*="send"] button',
    'button[class*="send"]',
    'button[aria-label*="发送"]',
    'button[aria-label*="Send"]',
    'button[type="submit"]',
  ],
  // "停止生成"按钮（判定流式进行中）
  stopButton: [
    'button[aria-label*="停止"]',
    'button[aria-label*="Stop"]',
    'div[class*="stop"] button',
  ],
};
