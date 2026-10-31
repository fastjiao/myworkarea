using System;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows.Automation;

// UI Automation 签到/领取 helper（通用版）
// 原理：通过 Windows UI Automation 找到目标按钮，程序化 InvokePattern.Invoke()
//       鼠标不动、不抢焦点
// 输出：JSON {"success":bool,"message":"..."}
// 日志：写入 exe 同目录 uia-checkin.log
//
// 参数：
//   args[0] = 进程名（默认 Hyperdown）
//   args[1] = 按钮关键词，管道分隔（默认 "签到|打卡"）
//   args[2] = 已完成关键词，管道分隔（默认 "已签"）
//   args[3] = 成功关键词，管道分隔（默认 "签到成功|今日已签|已签到|领取成功|已领取"）
//   args[4] = 导航按钮名，空字符串表示不需要导航（默认 "首页"）
class CheckinHelper {
  static string[] btnKeywords;
  static string[] doneKeywords;
  static string[] successKeywords;
  static string logFile = "";

  [DllImport("user32.dll")]
  static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")]
  static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
  [DllImport("user32.dll")]
  static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")]
  static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr hmodWinEventProc, WinEventDelegate lpfnWinEventProc, uint idProcess, uint idThread, uint dwFlags);
  [DllImport("user32.dll")]
  static extern bool UnhookWinEvent(IntPtr hWinEventHook);
  [DllImport("user32.dll")]
  static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);
  [DllImport("user32.dll", SetLastError = true)]
  static extern bool SystemParametersInfo(uint uiAction, uint uiParam, IntPtr pvParam, uint fWinIni);

  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  delegate void WinEventDelegate(IntPtr hWinEventHook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint dwEventThread, uint dwmsEventTime);

  const int SW_RESTORE = 9;
  const uint EVENT_OBJECT_SHOW = 0x8002;
  const uint WINEVENT_OUTOFCONTEXT = 0x0;
  const byte VK_TAB = 0x09;
  const uint KEYEVENTF_KEYUP = 0x2;
  const uint SPI_SETSCREENREADER = 0x0047;
  const uint SPIF_UPDATEINIFILE = 0x01;
  const uint SPIF_SENDCHANGE = 0x02;

  // 保持 WinEvent delegate 引用防止 GC 回收
  static WinEventDelegate _hookProc = null;

  static void Log(string msg) {
    try {
      if (logFile.Length == 0)
        logFile = System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "uia-checkin.log");
      System.IO.File.AppendAllText(logFile,
        DateTime.Now.ToString("HH:mm:ss.fff") + " " + msg + "\r\n");
    } catch { }
  }

  // 触发 Chromium/Electron 构建完整 UIA 无障碍树
  // Electron 默认不暴露 UIA 元素，需通过系统级信号让 Chromium 以为有屏幕阅读器在运行
  static void TriggerAccessibility(IntPtr hwnd) {
    Log("[无障碍] 设置 SPI_SETSCREENREADER=1");
    // 1. 设置系统级屏幕阅读器标志（Chromium 通过 SPI_GETSCREENREADER 检测）
    SystemParametersInfo(SPI_SETSCREENREADER, 1, IntPtr.Zero, SPIF_UPDATEINIFILE | SPIF_SENDCHANGE);
    // 2. 设置 WinEvent hook（让 Chromium 以为有 AT 工具在监听）
    _hookProc = (hWinEventHook, eventType, hwndEvt, idObject, idChild, dwEventThread, dwmsEventTime) => {};
    IntPtr hook = SetWinEventHook(EVENT_OBJECT_SHOW, EVENT_OBJECT_SHOW, IntPtr.Zero, _hookProc, 0, 0, WINEVENT_OUTOFCONTEXT);
    // 3. 发送 Tab 键触发 Chromium 无障碍
    Log("[无障碍] SetForegroundWindow + 发送 Tab 键");
    SetForegroundWindow(hwnd);
    Thread.Sleep(500);
    keybd_event(VK_TAB, 0, 0, IntPtr.Zero);
    Thread.Sleep(100);
    keybd_event(VK_TAB, 0, KEYEVENTF_KEYUP, IntPtr.Zero);
    // 4. 等待 Chromium 构建无障碍树
    Log("[无障碍] 等待 5s 构建无障碍树...");
    Thread.Sleep(5000);
    // 5. 释放 hook，恢复屏幕阅读器标志
    if (hook != IntPtr.Zero) UnhookWinEvent(hook);
    SystemParametersInfo(SPI_SETSCREENREADER, 0, IntPtr.Zero, SPIF_UPDATEINIFILE | SPIF_SENDCHANGE);
    Log("[无障碍] 已恢复 SPI_SETSCREENREADER=0");
  }

  static void Main(string[] args) {
    try {
      Log("========== uia-checkin 开始 ==========");
      string procName = args.Length > 0 ? args[0] : "Hyperdown";
      string btnKw = args.Length > 1 ? args[1] : "签到|打卡";
      string doneKw = args.Length > 2 ? args[2] : "已签";
      string successKw = args.Length > 3 ? args[3] : "签到成功|今日已签|已签到|领取成功|已领取";
      string navName = args.Length > 4 ? args[4] : "首页";

      Log("[参数] procName=" + procName + " btnKw=[" + btnKw + "] doneKw=[" + doneKw + "] successKw=[" + successKw + "] navName=[" + navName + "]");

      btnKeywords = btnKw.Split('|');
      doneKeywords = doneKw.Split('|');
      successKeywords = successKw.Split('|');

      Log("[进程] 查找进程: " + procName);
      System.Diagnostics.Process[] procs = System.Diagnostics.Process.GetProcessesByName(procName);
      Log("[进程] 找到 " + procs.Length + " 个进程");
      if (procs.Length == 0) { Out(false, procName + " 未运行"); return; }

      // 收集目标进程的所有 PID
      var pidSet = new HashSet<int>();
      foreach (System.Diagnostics.Process p in procs) pidSet.Add(p.Id);

      // 优先用 MainWindowHandle 找可见窗口
      AutomationElement root = null;
      IntPtr rootHwnd = IntPtr.Zero;
      foreach (System.Diagnostics.Process p in procs) {
        if (p.MainWindowHandle != IntPtr.Zero) {
          Log("[窗口] 尝试 MainWindowHandle=" + p.MainWindowHandle + " PID=" + p.Id);
          root = AutomationElement.FromHandle(p.MainWindowHandle);
          if (root != null) { rootHwnd = p.MainWindowHandle; Log("[窗口] 成功获取 AutomationElement"); break; }
        }
      }

      // 若没找到，用 EnumWindows 找隐藏的 Chrome_WidgetWin_1 窗口并显示
      if (root == null) {
        Log("[窗口] MainWindowHandle 未找到，尝试 EnumWindows 找隐藏窗口");
        IntPtr hiddenHwnd = FindHiddenWindow(pidSet);
        if (hiddenHwnd != IntPtr.Zero) {
          Log("[窗口] 找到隐藏窗口 " + hiddenHwnd + "，ShowWindow+SetForeground");
          ShowWindow(hiddenHwnd, SW_RESTORE);
          Thread.Sleep(2000);
          SetForegroundWindow(hiddenHwnd);
          Thread.Sleep(1000);
          root = AutomationElement.FromHandle(hiddenHwnd);
          rootHwnd = hiddenHwnd;
        } else {
          Log("[窗口] EnumWindows 也未找到隐藏窗口");
        }
      }
      if (root == null) { Out(false, "无法获取主窗口（程序可能最小化到托盘）"); return; }
      Log("[窗口] 最终使用窗口句柄: " + rootHwnd);

      // 触发 Chromium/Electron 无障碍模式（Electron 默认不暴露 UIA 元素）
      Log("[无障碍] 开始触发...");
      TriggerAccessibility(rootHwnd);
      root = AutomationElement.FromHandle(rootHwnd);
      Log("[无障碍] 触发完成，重新获取 root");

      // 枚举所有 Button 供调试
      DumpAllButtons(root);

      // 1. 找目标按钮
      Log("[签到] FindButton 查找签到按钮...");
      AutomationElement signBtn = FindButton(root);
      Log("[签到] FindButton 结果: " + (signBtn != null ? ("找到按钮 Name=[" + (signBtn.Current.Name ?? "") + "]") : "未找到"));
      if (signBtn == null && navName.Length > 0) {
        Log("[导航] 未找到签到按钮，尝试 ClickNav 导航: [" + navName + "]");
        if (!ClickNav(root, navName)) { Out(false, "未找到" + navName + "导航按钮，且当前页无目标按钮"); return; }
        Log("[导航] 导航按钮已点击，等待 4s 弹窗加载...");
        Thread.Sleep(4000);
        Log("[签到] 等待后重新 FindButton...");
        signBtn = FindButton(root);
        Log("[签到] 等待后 FindButton 结果: " + (signBtn != null ? ("找到按钮 Name=[" + (signBtn.Current.Name ?? "") + "]") : "未找到"));
        // 弹窗打开后再次枚举按钮
        if (signBtn != null) DumpAllButtons(root);
      }
      if (signBtn == null) {
        // 按钮未找到，检查是否已完成（页面上有已完成文字）
        Log("[判定] 未找到按钮，检查已完成文字...");
        if (HasDoneText(root)) { Out(true, "今日已完成（未找到按钮但检测到已完成状态）"); return; }
        Out(false, "未找到目标按钮，且未检测到已完成状态");
        return;
      }

      // 2. 检查是否已完成（按钮文本含已完成关键词）
      string btnName = signBtn.Current.Name ?? "";
      Log("[判定] 按钮名=[" + btnName + "] 检查是否已完成");
      if (ContainsAny(btnName, doneKeywords)) { Out(true, "今日已完成（按钮状态: " + btnName + "）"); return; }

      // 3. Invoke
      bool canInvoke = false;
      try { canInvoke = (bool)signBtn.GetCurrentPropertyValue(AutomationElement.IsInvokePatternAvailableProperty); } catch { }
      Log("[Invoke] IsInvokePatternAvailable=" + canInvoke + " 按钮=[" + btnName + "]");
      if (!canInvoke) { Out(false, "按钮不支持 InvokePattern: " + btnName); return; }

      Log("[Invoke] 调用 Invoke()...");
      ((InvokePattern)signBtn.GetCurrentPattern(InvokePattern.Pattern)).Invoke();
      Log("[Invoke] Invoke() 已调用");

      // 4. 轮询判定（最多 30 秒，每 2 秒查一次 UI 状态）
      for (int i = 0; i < 15; i++) {
        Thread.Sleep(2000);
        try {
          Log("[轮询] 第 " + (i + 1) + "/15 轮...");
          if (HasSuccessText(root)) { Log("[轮询] 检测到成功文字"); Out(true, "操作成功"); return; }
          AutomationElement btn2 = FindButton(root);
          if (btn2 != null && ContainsAny(btn2.Current.Name ?? "", doneKeywords)) {
            Log("[轮询] 按钮变为已完成状态: [" + (btn2.Current.Name ?? "") + "]");
            Out(true, "操作成功（按钮变为已完成状态）"); return;
          }
        } catch (Exception ex) { Log("[轮询] 异常: " + ex.Message); }
      }
      Log("[轮询] 30秒内未检测到明确成功提示");
      Out(true, "已点击按钮，30秒内未检测到明确成功提示（请看日志确认）");
    } catch (Exception ex) { Log("[异常] " + ex.Message); Out(false, "异常: " + ex.Message); }
  }

  // 调试：枚举 UIA 树中所有 Button 的 Name，写入日志（最多 100 个）
  static void DumpAllButtons(AutomationElement root) {
    try {
      TreeWalker walker = new TreeWalker(Condition.TrueCondition);
      DateTime deadline = DateTime.Now.AddSeconds(15);
      int count = 0, btnCount = 0;
      var stack = new Stack<AutomationElement>();
      stack.Push(root);
      var btnNames = new List<string>();
      while (stack.Count > 0 && count < 10000 && btnCount < 100) {
        if (DateTime.Now > deadline) break;
        AutomationElement cur = stack.Pop();
        count++;
        try {
          if (cur.Current.ControlType == ControlType.Button) {
            btnCount++;
            string nm = cur.Current.Name ?? "";
            bool canInvoke = false;
            try { canInvoke = (bool)cur.GetCurrentPropertyValue(AutomationElement.IsInvokePatternAvailableProperty); } catch { }
            btnNames.Add("  Button[" + btnCount + "] Name=[" + nm + "] Invoke=" + canInvoke);
          }
          AutomationElement child = walker.GetFirstChild(cur);
          while (child != null) { stack.Push(child); child = walker.GetNextSibling(child); }
        } catch { }
      }
      Log("[枚举] 遍历 " + count + " 节点，找到 " + btnCount + " 个 Button:");
      foreach (string s in btnNames) Log(s);
    } catch (Exception ex) { Log("[枚举] 异常: " + ex.Message); }
  }

  // 通过 EnumWindows 找到属于目标进程的隐藏 Electron 主窗口
  static IntPtr FindHiddenWindow(HashSet<int> pidSet) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hWnd, lParam) => {
      int pid;
      GetWindowThreadProcessId(hWnd, out pid);
      if (pidSet.Contains(pid)) {
        var cls = new System.Text.StringBuilder(256);
        GetClassName(hWnd, cls, 256);
        // Electron 主窗口类名：Chrome_WidgetWin_1
        if (cls.ToString() == "Chrome_WidgetWin_1") {
          found = hWnd;
          return false; // 停止枚举
        }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  static AutomationElement FindButton(AutomationElement root) {
    // 用 TreeWalker 逐节点遍历，带时间超时（Chromium UIA 树极大时 FindFirst/FindAll 会永久阻塞）
    TreeWalker walker = new TreeWalker(Condition.TrueCondition);
    DateTime deadline = DateTime.Now.AddSeconds(25);
    int count = 0, btnCount = 0;
    var stack = new Stack<AutomationElement>();
    stack.Push(root);
    while (stack.Count > 0 && count < 10000) {
      if (DateTime.Now > deadline) break;
      AutomationElement cur = stack.Pop();
      count++;
      try {
        if (cur.Current.ControlType == ControlType.Button) {
          btnCount++;
          string nm = cur.Current.Name ?? "";
          if (ContainsAny(nm, btnKeywords)) {
            Log("[FindButton] 遍历 " + count + " 节点/" + btnCount + " 按钮后匹配: [" + nm + "]");
            return cur;
          }
        }
        AutomationElement child = walker.GetFirstChild(cur);
        while (child != null) { stack.Push(child); child = walker.GetNextSibling(child); }
      } catch { }
    }
    Log("[FindButton] 遍历 " + count + " 节点/" + btnCount + " 按钮，未匹配");
    return null;
  }

  // 用 TreeWalker 手动遍历找按钮（子串匹配），限制最多遍历 5000 个元素防止卡死
  static AutomationElement FindButtonBySubstring(AutomationElement root) {
    return null; // 已在 FindButton 中统一处理
  }

  static bool HasDoneText(AutomationElement root) {
    return HasText(root, doneKeywords, 10);
  }

  static bool HasSuccessText(AutomationElement root) {
    return HasText(root, successKeywords, 10);
  }

  // 用 TreeWalker 逐节点遍历查找文本，带时间超时
  static bool HasText(AutomationElement root, string[] keywords, int timeoutSec) {
    TreeWalker walker = new TreeWalker(Condition.TrueCondition);
    DateTime deadline = DateTime.Now.AddSeconds(timeoutSec);
    int count = 0;
    var stack = new Stack<AutomationElement>();
    stack.Push(root);
    while (stack.Count > 0 && count < 5000) {
      if (DateTime.Now > deadline) break;
      AutomationElement cur = stack.Pop();
      count++;
      try {
        string nm = cur.Current.Name ?? "";
        if (ContainsAny(nm, keywords)) { Log("[HasText] 匹配到 [" + nm + "] (第 " + count + " 节点)"); return true; }
        AutomationElement child = walker.GetFirstChild(cur);
        while (child != null) { stack.Push(child); child = walker.GetNextSibling(child); }
      } catch { }
    }
    return false;
  }

  static bool ContainsAny(string text, string[] keywords) {
    foreach (string kw in keywords) {
      if (kw.Length > 0 && text.IndexOf(kw) >= 0) return true;
    }
    return false;
  }

  static bool ClickNav(AutomationElement root, string navName) {
    Log("[ClickNav] 查找导航按钮 Name 包含 [" + navName + "]");
    TreeWalker walker = new TreeWalker(Condition.TrueCondition);
    DateTime deadline = DateTime.Now.AddSeconds(15);
    int count = 0, btnCount = 0;
    var stack = new Stack<AutomationElement>();
    stack.Push(root);
    while (stack.Count > 0 && count < 5000) {
      if (DateTime.Now > deadline) break;
      AutomationElement cur = stack.Pop();
      count++;
      try {
        if (cur.Current.ControlType == ControlType.Button) {
          btnCount++;
          string nm = cur.Current.Name ?? "";
          if (nm.IndexOf(navName) >= 0) {
            Log("[ClickNav] 第 " + count + " 节点/" + btnCount + " 按钮匹配: [" + nm + "]");
            bool canInvoke = false;
            try { canInvoke = (bool)cur.GetCurrentPropertyValue(AutomationElement.IsInvokePatternAvailableProperty); } catch { }
            Log("[ClickNav] InvokePattern available=" + canInvoke);
            if (canInvoke) { ((InvokePattern)cur.GetCurrentPattern(InvokePattern.Pattern)).Invoke(); Log("[ClickNav] Invoke() 已调用"); return true; }
            Log("[ClickNav] 该按钮不支持 InvokePattern，继续查找");
          }
        }
        AutomationElement child = walker.GetFirstChild(cur);
        while (child != null) { stack.Push(child); child = walker.GetNextSibling(child); }
      } catch { }
    }
    Log("[ClickNav] 遍历 " + count + " 节点/" + btnCount + " 按钮，未找到匹配的导航按钮");
    return false;
  }

  static void Out(bool ok, string msg) {
    Log("[结果] success=" + ok + " message=" + msg);
    Console.WriteLine("{\"success\":" + (ok ? "true" : "false") + ",\"message\":" + JsonStr(msg) + "}");
  }

  static string JsonStr(string s) { return "\"" + (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ") + "\""; }
}
