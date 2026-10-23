// dsh-notify-overlay — Windows 置顶通知浮窗
//
// 三种形态，同一个窗口：
//   Card  临时卡片：新提醒弹出，N 秒后自动消失。没有计数、没有展开箭头，
//         只能「点进去」或「关闭」。
//   Ball  小球：持久提醒攒下来后缩成右下角一个圆球，带计数，可拖动。
//   List  列表：点小球展开，每条可进入或单独关掉，底部有收起按钮回到小球。
//
// 持久性由 host 判定（persistent 字段）：审批 / 提问 / 出错为持久，
// 卡片超时后进入列表并计入小球；轮次完成等非持久项超时后直接丢弃。
//
// 与 host 的协议（stdin/stdout，每行一个 JSON）：
//   host → 窗口:
//     {"op":"notify","items":[{"sessionId","kind","title","body","sessionLabel","at","persistent"}],"autoHideMs","lang"}
//     {"op":"remove","sessionId":"...","kind":"..."}
//     {"op":"clear"}
//     {"op":"theme","dark":true}
//     {"op":"config","autoHideMs","scale","sound","lang"}
//     {"op":"exit"}
//   窗口 → host:
//     {"op":"ready"}
//     {"op":"click","sessionId":"..."}
//     {"op":"error","message":"..."}

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace DshNotifyOverlay
{
    // ── 一条提醒 ───────────────────────────────────────────────
    sealed class Item
    {
        public string SessionId = "";
        public string Kind = "";
        public string Title = "";
        public string Body = "";
        public string SessionLabel = "";
        public double At;
        /// <summary>持久类：卡片消失后进列表、计小球。由 host 判定。</summary>
        public bool Persistent;
    }

    // ── 主题（取自 DSH CSS 变量）────────────────────────────────
    sealed class Palette
    {
        public bool Dark = true;

        public Color Glass => Dark ? Argba("#2C2C2E", 0xF4) : Argba("#F7F7F9", 0xFD);
        public Color Stroke => Dark ? Argba("#FFFFFF", 0x1F) : Argba("#000000", 0x24);
        public Color Divider => Dark ? Argba("#FFFFFF", 0x14) : Argba("#000000", 0x12);
        public Color Chip => Dark ? Argba("#FFFFFF", 0x12) : Argba("#000000", 0x08);
        /// <summary>整行悬停底色。浅色卡片接近白，需要更深的叠加才看得见。</summary>
        public Color Hover => Dark ? Argba("#FFFFFF", 0x0A) : Argba("#0F1115", 0x24);
        public Color Text => Dark ? Hex("#F9FAFB") : Hex("#0F1115");
        public Color TextDim => Dark ? Hex("#ADB2B8") : Hex("#6B7075");

        /// <summary>小球计数角标：深色用亮底深字，浅色反过来。</summary>
        public Color BadgeBg => Dark ? Argba("#F9FAFB", 0xF2) : Argba("#0F1115", 0xF2);
        public Color BadgeText => Dark ? Hex("#1A1A1C") : Hex("#F9FAFB");
        public Color BadgeStroke => Dark ? Argba("#000000", 0x33) : Argba("#FFFFFF", 0x55);

        public Color Accent(string kind) => Dark
            ? kind switch
            {
                "approval" => Hex("#F59E0B"),
                "question" => Hex("#3B82F6"),
                "error" => Hex("#EF4444"),
                "turn" => Hex("#22C55E"),
                "subagent" => Hex("#22C55E"),
                _ => Hex("#81858C"),
            }
            : kind switch
            {
                "approval" => Hex("#B45309"),
                "question" => Hex("#1D4ED8"),
                "error" => Hex("#B91C1C"),
                "turn" => Hex("#15803D"),
                "subagent" => Hex("#15803D"),
                _ => Hex("#6B7280"),
            };

        public static Color Hex(string h)
        {
            h = h.TrimStart('#');
            return Color.FromRgb(
                Convert.ToByte(h.Substring(0, 2), 16),
                Convert.ToByte(h.Substring(2, 2), 16),
                Convert.ToByte(h.Substring(4, 2), 16));
        }

        static Color Argba(string h, byte a)
        {
            var c = Hex(h);
            return Color.FromArgb(a, c.R, c.G, c.B);
        }
    }

    // ── Win32：唤回 DSH 主窗口 ─────────────────────────────────
    static class Shell
    {
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lp);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int n);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();

        delegate bool EnumProc(IntPtr h, IntPtr lp);

        [StructLayout(LayoutKind.Sequential)]
        struct RECT { public int Left, Top, Right, Bottom; }

        const int SW_RESTORE = 9, SW_SHOW = 5, SW_SHOWMAXIMIZED = 3;

        /// <summary>
        /// 把 DSH 主窗口提到前台。两条分支，各自的唤回方式都经过实测（2026-10-23）：
        ///
        /// | 起始状态            | 动作                                    | 结果          |
        /// |---------------------|-----------------------------------------|---------------|
        /// | 最小化              | `SW_RESTORE` + `SetForegroundWindow`    | ✅ 不卡       |
        /// | 点 X 隐藏到托盘     | **`explorer.exe dsh://open`**           | ✅ 唤回且不卡 |
        /// | 托盘但用 ShowWindow | `SW_SHOWMAXIMIZED`                      | ❌ **卡死**   |
        ///
        /// **托盘分支绝不能调 `ShowWindow`**：`window.hide()` 是 Electron 主动
        /// 隐藏，它内部的可见性状态是 false。外部 Win32 的 `ShowWindow` 强行把
        /// 窗口显示出来时 Electron 并不知道，渲染层停在「暂停」状态，界面就
        /// 卡死。`dsh://open` 走的是 `main.js` 的 `focusPrimaryWindow()` →
        /// `window.show()`，属于 Electron 内部 API，状态同步，不卡。
        ///
        /// **已最大化时绝不能调 SW_SHOW/SW_RESTORE**：会按「正常大小」显示，
        /// 把最大化覆盖掉（实测从 2575x1407 变成居中窗口）。
        ///
        /// **找窗口分两层，顺序不能反**：
        ///   1. 先用 `Process.MainWindowHandle`。窗口可见/最小化/最大化时它都有值，
        ///      是系统判定的主窗口，不会选到 Electron 的辅助顶层窗口
        ///      （`Chrome_WidgetWin_0` / `Electron_NotifyIconHostWindow` /
        ///      `Base_PowerMessageWindow` / IME）。
        ///   2. **只有它为 0 才枚举**。点 X 隐藏后 `MainWindowHandle` 归零，但句柄
        ///      仍然有效，只有 `EnumWindows` 拿得到；这时按面积取最大的。
        /// 反过来（永远枚举）会让辅助窗口参与竞争，可能选中非页面窗口，屏幕上
        /// 就多出一个空白窗口。
        ///
        /// **不要加 AttachThreadInput / SetWindowPos TOPMOST 往返 / BringWindowToTop**：
        /// 早期都试过，在后台进程里全部无效。
        /// </summary>
        public static bool FocusDsh()
        {
            IntPtr best = IntPtr.Zero;
            int bestArea = -1;
            var report = new System.Text.StringBuilder();

            foreach (var proc in System.Diagnostics.Process.GetProcessesByName("DeepSeek Harness"))
            {
                // 第一层：系统给的主窗口句柄。窗口仍在任务栏上时它总是有效的。
                if (proc.MainWindowHandle != IntPtr.Zero)
                {
                    RECT r;
                    int a = GetWindowRect(proc.MainWindowHandle, out r)
                        ? (r.Right - r.Left) * (r.Bottom - r.Top)
                        : 0;
                    report.Append($" main={proc.MainWindowHandle}({a})");
                    if (a > bestArea) { bestArea = a; best = proc.MainWindowHandle; }
                }

                // 第二层：主窗口句柄为空（隐藏到托盘）时才枚举该进程的顶层窗口。
                if (best != IntPtr.Zero) continue;
                var pid = (uint)proc.Id;
                EnumWindows((h, lp) =>
                {
                    uint p;
                    GetWindowThreadProcessId(h, out p);
                    if (p != pid) return true;
                    RECT r;
                    if (!GetWindowRect(h, out r)) return true;
                    int a = (r.Right - r.Left) * (r.Bottom - r.Top);
                    report.Append($" enum={h}({a},vis={(IsWindowVisible(h) ? 1 : 0)})");
                    if (a > bestArea) { bestArea = a; best = h; }
                    return true;
                }, IntPtr.Zero);
            }
            Overlay.Trace($"focus candidates:{report}");

            if (best == IntPtr.Zero)
            {
                Overlay.Trace("focus: no window found");
                return false;
            }

            var before = IsWindowVisible(best);
            var iconic = IsIconic(best);
            var zoomed = IsZoomed(best);

            // 托盘分支（点 X 隐藏）：**必须走协议**，不能调 ShowWindow。
            // Electron 主动 hide 之后，外部 ShowWindow 会让它停在渲染暂停状态
            // （实测：SW_SHOWMAXIMIZED 唤回后整个窗口卡死）。
            // dsh://open 走 main.js 的 focusPrimaryWindow() → window.show()，
            // 状态同步，唤回后不卡。
            if (!before && !iconic)
            {
                LaunchProtocol();
                var came = WaitForForeground(best, 40, 25);
                Overlay.Trace($"focus: hwnd={best} visible={before} zoomed={zoomed} via=protocol ok={came}");
                return came;
            }

            if (iconic) ShowWindow(best, SW_RESTORE);

            SetForegroundWindow(best);
            var ok = WaitForForeground(best, 10, 15);
            Overlay.Trace($"focus: hwnd={best} visible={before} iconic={iconic} zoomed={zoomed} via=win32 ok={ok}");
            return ok;
        }

        /// <summary>
        /// 触发 `dsh://open`，让 Electron 自己把主窗口显示出来。
        ///
        /// 用 `explorer.exe <url>` 而不是 `Process.Start(url)`：后者在部分环境下
        /// 会被「Open with」对话框拦下，而 explorer 是触发自定义协议的标准做法
        /// （实测有效的正是这一种）。
        /// </summary>
        static void LaunchProtocol()
        {
            try
            {
                var psi = new System.Diagnostics.ProcessStartInfo
                {
                    FileName = "explorer.exe",
                    Arguments = "dsh://open",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                System.Diagnostics.Process.Start(psi);
                Overlay.Trace("focus: launched explorer.exe dsh://open");
            }
            catch (Exception ex)
            {
                Overlay.Trace($"focus: protocol launch failed: {ex.Message}");
            }
        }

        /// <summary>
        /// 轮询等待某个窗口成为前台。
        ///
        /// 协议唤回和 SetForegroundWindow 都不是同步完成的，立刻读
        /// `GetForegroundWindow()` 会读到旧值，把成功误判成失败。
        /// @param target - 期望成为前台的窗口。
        /// @param attempts - 轮询次数。
        /// @param delayMs - 每次间隔。
        /// @returns 是否在超时前成为前台。
        /// </summary>
        static bool WaitForForeground(IntPtr target, int attempts, int delayMs)
        {
            for (var i = 0; i < attempts; i++)
            {
                if (GetForegroundWindow() == target) return true;
                System.Threading.Thread.Sleep(delayMs);
            }
            return GetForegroundWindow() == target;
        }
    }

    // ── 应用图标 ───────────────────────────────────────────────
    //
    // 用 DSH 官方鲸鱼 logo 的矢量路径直接绘制（见 WhalePath），不做任何位图处理：
    // 矢量在任意尺寸都清晰，不会有锯齿，也不用从 PNG 里抠图。
    //
    // 官方前端给了两份，只有 fill 不同（favicon.svg 黑 / favicon-dark.svg 白），
    // path 完全一致，所以这里按主题换颜色即可。
    static class AppIcon
    {
        static Geometry? cachedGeometry;

        /// <summary>鲸鱼轮廓。50×50 坐标系，使用时按目标尺寸缩放。</summary>
        static Geometry Geometry
        {
            get
            {
                if (cachedGeometry == null)
                {
                    var g = System.Windows.Media.Geometry.Parse(WhalePath.Data);
                    g.Freeze();
                    cachedGeometry = g;
                }
                return cachedGeometry;
            }
        }

        /// <summary>
        /// 画一只指定尺寸、指定颜色的鲸鱼。
        /// 深色主题传白色，浅色主题传近黑色。
        /// @param align 水平对齐方式；来源行靠左，小球居中。
        /// </summary>
        public static System.Windows.Shapes.Path Draw(
            bool isDark, double size, HorizontalAlignment align = HorizontalAlignment.Center)
        {
            var path = new System.Windows.Shapes.Path
            {
                Data = Geometry,
                Fill = new SolidColorBrush(isDark ? Colors.White : Palette.Hex("#0F1115")),
                Stretch = Stretch.Uniform,
                Width = size,
                Height = size,
                HorizontalAlignment = align,
                VerticalAlignment = VerticalAlignment.Center,
            };
            return path;
        }
    }

    // ── 主窗口 ─────────────────────────────────────────────────
    public sealed class Overlay : Window
    {
        const double CardW = 460;
        const double Pad = 18;
        const double EdgeGap = 20;
        const double HitSize = 30;
        const double BallSize = 72;
        const double BadgeSize = 24;
        /// <summary>离工作区边缘多近才吸附（DIP）。超出这个距离就停在松手处。</summary>
        const double SnapDistance = 24;
        const double SnapMargin = 8;

        enum Mode { Hidden, Card, Ball, List }

        readonly Palette pal = new();
        readonly StackPanel stack = new()
        {
            HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Bottom,
        };
        readonly DispatcherTimer cardTimer = new();

        // ── 数据 ────────────────────────────────────────────────
        /// <summary>等待显示的临时卡片，先进先出。</summary>
        readonly List<Item> queue = new();
        /// <summary>持久提醒，进列表、进小球计数。</summary>
        readonly List<Item> pending = new();
        /// <summary>当前正显示的临时卡片。</summary>
        Item? showing;

        Mode mode = Mode.Hidden;
        double autoHideMs = 6000;
        double scale = 1;
        /// <summary>界面语言，由 host 下发：zh / en。</summary>
        string lang = "zh";
        Grid scalingHost = null!;
        readonly List<(string Name, FrameworkElement El)> hotzones = new();
        /// <summary>热区对应的点击动作，供 simclick 直接调用（测试用）。</summary>
        readonly Dictionary<string, Action> hotActions = new();

        // 小球位置（屏幕 DIP），只存内存；重启回右下角。
        Point ballPos;
        bool ballPosReady;
        bool dragging;
        bool dragMoved;
        Vector dragGrab;
        Point dragStart;

        int handlingClick;
        /// <summary>窗口当前是否处于「已显示」状态，由 Appear / HideWindow 维护。</summary>
        bool shown;

        public Overlay()
        {
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            Topmost = true;
            ShowInTaskbar = false;
            ResizeMode = ResizeMode.NoResize;
            ShowActivated = false;
            SizeToContent = SizeToContent.WidthAndHeight;
            UseLayoutRounding = true;
            Opacity = 0;

            var tg = new TransformGroup();
            tg.Children.Add(new TranslateTransform(0, 0));
            tg.Children.Add(new ScaleTransform(1, 1));
            stack.RenderTransform = tg;

            var host = new Grid
            {
                Margin = new Thickness(Pad),
                LayoutTransform = new ScaleTransform(1, 1),
            };
            host.Children.Add(stack);
            Content = host;
            scalingHost = host;

            cardTimer.Tick += (_, _) => { cardTimer.Stop(); CardExpired(); };
            Loaded += (_, _) => Reposition();
            SizeChanged += (_, _) => Reposition();
        }

        // ══ 状态机 ═══════════════════════════════════════════════

        /// <summary>新提醒进来：入队并立刻弹下一张。</summary>
        void Enqueue(IEnumerable<Item> items, double hideMs)
        {
            autoHideMs = hideMs;
            foreach (var it in items) queue.Add(it);
            if (mode != Mode.Card) ShowNextCard();
        }

        /// <summary>弹下一张卡片；队列空了按 pending 决定回小球还是隐藏。</summary>
        void ShowNextCard()
        {
            if (queue.Count == 0)
            {
                showing = null;
                GoIdle();
                return;
            }
            showing = queue[0];
            queue.RemoveAt(0);
            mode = Mode.Card;
            Render();
            // 这里**不响铃**：响不响完全由 host 用独立的 sound 指令决定。
            // 卡片自己发声会让「静音」「去重」「只响不放」三种情况都绕不过来。

            cardTimer.Stop();
            cardTimer.Interval = TimeSpan.FromMilliseconds(autoHideMs);
            cardTimer.Start();
        }

        /// <summary>队列空时决定停在哪：有持久提醒就露小球，没有就整个隐藏。</summary>
        void GoIdle()
        {
            cardTimer.Stop();
            mode = pending.Count > 0 ? Mode.Ball : Mode.Hidden;
            Render();
        }

        /// <summary>卡片超时：持久类转进列表，非持久类直接丢弃。</summary>
        void CardExpired()
        {
            var it = showing;
            showing = null;
            if (it != null && it.Persistent) AddPending(it);
            ShowNextCard();
        }

        /// <summary>加入持久列表，同一会话同一类型只留一条，按优先级排序。</summary>
        void AddPending(Item it)
        {
            pending.RemoveAll(x => x.SessionId == it.SessionId && x.Kind == it.Kind);
            pending.Add(it);
            pending.Sort((a, b) =>
            {
                int p = Prio(a.Kind).CompareTo(Prio(b.Kind));
                return p != 0 ? p : b.At.CompareTo(a.At);
            });
        }

        // ══ 交互 ═════════════════════════════════════════════════

        /// <summary>点卡片主体或列表某行：唤起 DSH 并跳会话。</summary>
        void Jump(Item it)
        {
            if (Interlocked.CompareExchange(ref handlingClick, 1, 0) != 0) return;
            try
            {
                var sessionId = it.SessionId;

                // 先收卡片，再去唤 DSH。
                //
                // FocusDsh 在托盘分支要等 Electron 响应协议（最长约 1 秒）。
                // 如果先唤再收，卡片会一直挂在屏幕上等那一秒，点起来就是「卡手」。
                // 用户已经点击了，收起的意图是明确的，不必等唤回结果。
                showing = null;
                pending.RemoveAll(x => x.SessionId == sessionId && x.Kind == it.Kind);
                cardTimer.Stop();
                ShowNextCard();

                // 告诉 host 跳会话。这一步只写 stdout，不阻塞 UI。
                Emit(new { op = "click", sessionId });

                // 最后才唤 DSH，而且放到后台线程：FocusDsh 内部会轮询等待窗口
                // 成为前台（托盘分支最长约 1 秒），在 UI 线程上等会把整个浮窗
                // 冻住——刚收起的卡片会凝固在屏幕上，看起来就是「卡手」。
                // ShowWindow / SetForegroundWindow 都是跨进程调用，不要求调用方
                // 在 UI 线程，所以后台执行是安全的。
                System.Threading.Tasks.Task.Run(() =>
                {
                    try
                    {
                        var focused = Shell.FocusDsh();
                        Trace($"jump focus={focused} session={sessionId}");
                    }
                    catch (Exception ex)
                    {
                        Trace($"jump focus threw: {ex.Message}");
                    }
                });
            }
            finally { Interlocked.Exchange(ref handlingClick, 0); }
        }

        /// <summary>关掉当前卡片。持久类仍然进列表，只是不用等它超时。</summary>
        void CloseCard()
        {
            if (Interlocked.CompareExchange(ref handlingClick, 1, 0) != 0) return;
            try
            {
                var it = showing;
                showing = null;
                if (it != null && it.Persistent) AddPending(it);
                cardTimer.Stop();
                ShowNextCard();
            }
            finally { Interlocked.Exchange(ref handlingClick, 0); }
        }

        /// <summary>列表里单独关掉一条。列表空了就整个隐藏。</summary>
        void ClosePending(Item it)
        {
            if (Interlocked.CompareExchange(ref handlingClick, 1, 0) != 0) return;
            try
            {
                pending.RemoveAll(x => x.SessionId == it.SessionId && x.Kind == it.Kind);
                if (pending.Count == 0) mode = Mode.Hidden;
                Render();
            }
            finally { Interlocked.Exchange(ref handlingClick, 0); }
        }

        /// <summary>列表底部收起：回到小球。</summary>
        void ExitList()
        {
            mode = pending.Count > 0 ? Mode.Ball : Mode.Hidden;
            Render();
        }

        /// <summary>host 撤下某条持久提醒（已处理 / 已看到）。</summary>
        void Withdraw(string sessionId, string kind)
        {
            pending.RemoveAll(x => x.SessionId == sessionId && x.Kind == kind);

            // 只剩卡片在显示时不去打扰它；小球 / 列表要跟着 pending 走。
            if (mode == Mode.List && pending.Count == 0) mode = Mode.Hidden;
            else if (mode == Mode.Ball && pending.Count == 0) mode = Mode.Hidden;

            if (mode == Mode.List || mode == Mode.Ball || mode == Mode.Hidden) Render();
        }

        /// <summary>点小球展开列表。</summary>
        void OpenList()
        {
            mode = Mode.List;
            Render();
        }

        // ══ 渲染 ═════════════════════════════════════════════════

        void Render()
        {
            stack.Children.Clear();
            hotzones.Clear();
            hotActions.Clear();

            switch (mode)
            {
                case Mode.Card when showing != null:
                    stack.Children.Add(BuildCard(showing));
                    break;
                case Mode.Ball:
                    stack.Children.Add(BuildBall());
                    break;
                case Mode.List:
                    stack.Children.Add(BuildList());
                    break;
                default:
                    HideWindow();
                    return;
            }

            // 不能拿 Opacity 判断「是否已经显示」：Appear 挂的是动画，
            // Opacity 读到的是动画当前值而不是基础值，判断会不可靠
            // （第一次显示后动画停在 1，之后再 Hide 也不会自动归位）。
            // 用一个独立标志记录窗口是否处于显示状态。
            if (!shown) Appear();
            Reposition();
        }

        // ── 临时卡片 ────────────────────────────────────────────
        /// <summary>
        /// 新提醒卡片：来源行 + 一条内容行。
        /// 没有计数、没有展开箭头——它只表示「刚刚发生了什么」，只能点进去或关掉。
        /// 来源行下面不加分隔线。
        /// </summary>
        Border BuildCard(Item it)
        {
            var shell = ShellBorder();
            var inner = new StackPanel();
            inner.Children.Add(BuildSourceLine());
            inner.Children.Add(BuildItemLine(it, top: true,
                onClick: () => Jump(it), onClose: CloseCard));
            shell.Child = inner;
            return shell;
        }

        // ── 小球 ────────────────────────────────────────────────
        /// <summary>收起态小球：圆形、带计数角标、可拖动。单击展开列表。</summary>
        FrameworkElement BuildBall()
        {
            var root = new Grid { Width = BallSize, Height = BallSize, Cursor = Cursors.Hand };

            root.Children.Add(new Border
            {
                Width = BallSize,
                Height = BallSize,
                CornerRadius = new CornerRadius(BallSize / 2),
                BorderThickness = new Thickness(1),
                Background = BallBrush(),
                BorderBrush = new SolidColorBrush(pal.Stroke),
                Effect = Shadow(),
            });

            // 矢量鲸鱼，随主题换色：深色白鲸、浅色黑鲸
            var iconSide = BallSize * 0.56;
            root.Children.Add(AppIcon.Draw(pal.Dark, iconSide));

            // 计数角标贴在右上角
            var badge = new Border
            {
                MinWidth = BadgeSize,
                Height = BadgeSize,
                CornerRadius = new CornerRadius(BadgeSize / 2),
                Background = new SolidColorBrush(pal.BadgeBg),
                BorderThickness = new Thickness(1),
                BorderBrush = new SolidColorBrush(pal.BadgeStroke),
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Top,
                Margin = new Thickness(0, -5, -5, 0),
                Padding = new Thickness(5, 0, 5, 1),
            };
            badge.Child = new TextBlock
            {
                Text = pending.Count > 99 ? "99+" : pending.Count.ToString(),
                FontSize = 11.5,
                FontWeight = FontWeights.SemiBold,
                Foreground = new SolidColorBrush(pal.BadgeText),
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            };
            root.Children.Add(badge);

            // 拖动 + 点击：位移超过 3px 才算拖动，否则当点击
            root.MouseLeftButtonDown += (_, e) =>
            {
                dragging = true;
                dragMoved = false;
                dragStart = PointToScreenDip(e);
                dragGrab = new Vector(dragStart.X - Left, dragStart.Y - Top);
                try { root.CaptureMouse(); } catch { }
            };
            root.MouseMove += (_, e) =>
            {
                if (!dragging) return;
                var p = PointToScreenDip(e);
                if (!dragMoved && (Math.Abs(p.X - dragStart.X) > 3 || Math.Abs(p.Y - dragStart.Y) > 3))
                    dragMoved = true;
                if (!dragMoved) return;
                Left = p.X - dragGrab.X;
                Top = p.Y - dragGrab.Y;
            };
            root.MouseLeftButtonUp += (_, e) =>
            {
                if (!dragging) return;
                dragging = false;
                try { root.ReleaseMouseCapture(); } catch { }
                if (dragMoved) SnapBall();
                else OpenList();
            };

            hotzones.Add(("ball", root));
            hotActions["ball"] = OpenList;
            return root;
        }

        /// <summary>
        /// 松手后处理小球位置：
        ///   · 先夹回工作区，保证整个球可见（防止拖出屏幕）
        ///   · 只有松手处离左右边缘小于 SnapDistance 才吸附，否则停在原地
        /// 之前是无条件吸边，拖到屏幕中间也会被拽走，这是错的。
        /// </summary>
        void SnapBall()
        {
            var wa = SystemParameters.WorkArea;
            double w = ActualWidth > 0 ? ActualWidth : BallSize + Pad * 2;
            double h = ActualHeight > 0 ? ActualHeight : BallSize + Pad * 2;

            double minLeft = wa.Left - Pad + SnapMargin;
            double maxLeft = wa.Right - w + Pad - SnapMargin;
            double minTop = wa.Top - Pad + SnapMargin;
            double maxTop = wa.Bottom - h + Pad - SnapMargin;
            if (maxLeft < minLeft) maxLeft = minLeft;
            if (maxTop < minTop) maxTop = minTop;

            // 先夹回可见范围
            double left = Math.Max(minLeft, Math.Min(Left, maxLeft));
            double top = Math.Max(minTop, Math.Min(Top, maxTop));

            // 只有本来就贴近边缘才吸附
            if (left - minLeft < SnapDistance) left = minLeft;
            else if (maxLeft - left < SnapDistance) left = maxLeft;

            ballPos = new Point(left, top);
            ballPosReady = true;
            Left = left;
            Top = top;
        }

        // ── 列表 ────────────────────────────────────────────────
        /// <summary>展开列表：来源行 + 每条持久提醒 + 底部收起按钮。行间用分隔线。</summary>
        Border BuildList()
        {
            var shell = ShellBorder();
            var inner = new StackPanel();
            inner.Children.Add(BuildSourceLine());

            for (int i = 0; i < pending.Count; i++)
            {
                if (i > 0) inner.Children.Add(Divider());
                var it = pending[i];
                inner.Children.Add(BuildItemLine(it, top: false,
                    onClick: () => Jump(it), onClose: () => ClosePending(it)));
            }

            inner.Children.Add(Divider());
            inner.Children.Add(BuildFooter());
            shell.Child = inner;
            return shell;
        }

        /// <summary>列表底部的收起按钮。</summary>
        Grid BuildFooter()
        {
            var row = new Grid
            {
                Height = 36,
                Background = Brushes.Transparent,
                Cursor = Cursors.Hand,
            };

            var hoverPad = new Border
            {
                Margin = new Thickness(6, 3, 6, 3),
                CornerRadius = new CornerRadius(8),
                Background = Brushes.Transparent,
                IsHitTestVisible = false,
            };
            row.Children.Add(hoverPad);

            row.Children.Add(new TextBlock
            {
                Text = lang == "zh" ? "收起" : "Collapse",
                FontSize = 12,
                Foreground = new SolidColorBrush(pal.TextDim),
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            });

            row.MouseEnter += (_, _) => hoverPad.Background = new SolidColorBrush(pal.Hover);
            row.MouseLeave += (_, _) => hoverPad.Background = Brushes.Transparent;
            row.MouseLeftButtonUp += (_, e) => { e.Handled = true; ExitList(); };

            hotzones.Add(("footer", row));
            hotActions["footer"] = ExitList;
            return row;
        }

        // ── 公共积木 ────────────────────────────────────────────

        Border ShellBorder() => new()
        {
            Width = CardW,
            CornerRadius = new CornerRadius(12),
            BorderThickness = new Thickness(1),
            Background = new SolidColorBrush(pal.Glass),
            BorderBrush = new SolidColorBrush(pal.Stroke),
            Effect = Shadow(),
        };

        Border Divider() => new()
        {
            Height = 1,
            Margin = new Thickness(6, 0, 6, 0),
            Background = new SolidColorBrush(pal.Divider),
        };

        /// <summary>
        /// 来源行：图标 + 应用名。纯标签，不响应任何鼠标事件。
        /// 上下内距沿用已确认的观感：上 14px、下 4px（下方紧接内容行自己的上内距）。
        /// </summary>
        Grid BuildSourceLine()
        {
            var line = new Grid
            {
                Margin = new Thickness(16, 14, 16, 4),
                IsHitTestVisible = false,
            };
            line.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            line.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            var iconSlot = new Grid { Width = 22, VerticalAlignment = VerticalAlignment.Center };
            iconSlot.Children.Add(AppIcon.Draw(pal.Dark, 17, HorizontalAlignment.Left));
            Grid.SetColumn(iconSlot, 0);
            line.Children.Add(iconSlot);

            var appName = new TextBlock
            {
                Text = "DeepSeek Harness",
                FontSize = 12,
                VerticalAlignment = VerticalAlignment.Center,
                Foreground = new SolidColorBrush(pal.TextDim),
                Opacity = 0.9,
            };
            Grid.SetColumn(appName, 1);
            line.Children.Add(appName);

            return line;
        }

        /// <summary>一条提醒行。所有行同高同内距，悬停整行变色，右侧常显 ✕。</summary>
        Grid BuildItemLine(Item it, bool top, Action onClick, Action onClose)
        {
            var host = new Grid { Background = Brushes.Transparent, Cursor = Cursors.Hand };

            var hoverPad = new Border
            {
                Margin = new Thickness(6, 0, 6, 0),
                CornerRadius = new CornerRadius(8),
                Background = Brushes.Transparent,
                IsHitTestVisible = false,
            };
            host.Children.Add(hoverPad);

            var line = new Grid { Margin = new Thickness(16, 9, 16, 12) };
            line.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            line.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            line.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            var dotSlot = new Grid { Width = 19, VerticalAlignment = VerticalAlignment.Center };
            dotSlot.Children.Add(new Border
            {
                Width = 8,
                Height = 8,
                CornerRadius = new CornerRadius(4),
                Background = new SolidColorBrush(pal.Accent(it.Kind)),
                VerticalAlignment = VerticalAlignment.Center,
                HorizontalAlignment = HorizontalAlignment.Left,
            });
            Grid.SetColumn(dotSlot, 0);
            line.Children.Add(dotSlot);

            var texts = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
            texts.Children.Add(new TextBlock
            {
                Text = Label(it),
                FontSize = top ? 15 : 14,
                FontWeight = FontWeights.SemiBold,
                Foreground = new SolidColorBrush(pal.Text),
                TextTrimming = TextTrimming.CharacterEllipsis,
                TextWrapping = TextWrapping.NoWrap,
            });
            // 不限行数：窗口是 SizeToContent="WidthAndHeight"，
            // 内容多高卡片就多高。截断会让用户看不到关键信息。
            texts.Children.Add(new TextBlock
            {
                Text = Sub(it),
                FontSize = 12.5,
                Margin = new Thickness(0, 2, 0, 0),
                Foreground = new SolidColorBrush(pal.TextDim),
                TextWrapping = TextWrapping.Wrap,
            });
            Grid.SetColumn(texts, 1);
            line.Children.Add(texts);

            var xHit = new Border
            {
                Width = HitSize,
                Height = HitSize,
                Background = Brushes.Transparent,
                CornerRadius = new CornerRadius(6),
                Cursor = Cursors.Hand,
                VerticalAlignment = VerticalAlignment.Center,
            };
            xHit.Child = new TextBlock
            {
                Text = "\uE711",
                FontFamily = new FontFamily("Segoe MDL2 Assets"),
                FontSize = 11,
                Foreground = new SolidColorBrush(pal.TextDim),
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            };
            xHit.MouseEnter += (_, _) => xHit.Background = new SolidColorBrush(pal.Chip);
            xHit.MouseLeave += (_, _) => xHit.Background = Brushes.Transparent;
            xHit.MouseLeftButtonUp += (_, e) => { e.Handled = true; onClose(); };
            Grid.SetColumn(xHit, 2);
            line.Children.Add(xHit);
            hotzones.Add((top ? "cardclose" : "rowclose-" + it.SessionId, xHit));
            hotActions[top ? "cardclose" : "rowclose-" + it.SessionId] = onClose;

            host.Children.Add(line);

            host.MouseEnter += (_, _) => hoverPad.Background = new SolidColorBrush(pal.Hover);
            host.MouseLeave += (_, _) => hoverPad.Background = Brushes.Transparent;
            host.MouseLeftButtonUp += (_, e) => { e.Handled = true; onClick(); };

            hotzones.Add((top ? "card" : "row-" + it.SessionId, host));
            hotActions[top ? "card" : "row-" + it.SessionId] = onClick;
            return host;
        }

        // ── 文案 ────────────────────────────────────────────────
        bool Zh => lang == "zh";

        static int Prio(string kind) => kind switch
        {
            "approval" => 0,
            "question" => 0,
            "error" => 1,
            _ => 3,
        };

        string Status(string kind) => kind switch
        {
            "approval" => Zh ? "需要审批" : "Approval needed",
            "question" => Zh ? "需要你回答" : "Answer needed",
            "error" => Zh ? "出错" : "Failed",
            "turn" => Zh ? "轮次完成" : "Turn complete",
            "subagent" => Zh ? "子代理完成" : "Subagent finished",
            "sessionDone" => Zh ? "会话结束" : "Conversation closed",
            _ => Zh ? "有更新" : "Update",
        };

        static string Label(Item it)
            => it.SessionLabel.Length > 0 && !IsIdPrefix(it.SessionLabel) ? it.SessionLabel
             : it.Title.Length > 0 ? it.Title
             : "DSH";

        /// <summary>
        /// 会话 id 的前缀（`session-` 或 `session-1234abcd`）不能当标题显示。
        /// 标题服务还没归纳出标题时，Host 会退回 id 前缀，那串字符对用户没有意义。
        /// </summary>
        static bool IsIdPrefix(string text)
            => text == "session-"
            || (text.StartsWith("session-", StringComparison.Ordinal) && text.Length <= "session-1234abcd".Length);

        /// <summary>
        /// 折叠空白：正文里的换行统一成空格，避免一段多行文本把卡片撑出一堆空行。
        /// 不截断——卡片高度本来就跟内容走。
        /// </summary>
        static string Flatten(string text)
            => System.Text.RegularExpressions.Regex.Replace(text, @"\s+", " ").Trim();

        string Sub(Item it)
        {
            var s = Status(it.Kind);
            var extra = Flatten(it.Body);
            if (extra.Length == 0) return s;
            return s + " · " + extra;
        }

        // ── 画笔 ────────────────────────────────────────────────
        /// <summary>
        /// 小球底色。两层结构：底色 + 鲸鱼剪影。
        /// 深色用深灰圆配白鲸鱼，浅色用浅灰圆配深鲸鱼。
        /// 浅色不用纯白：纯白圆压在深色桌面/编辑器上太刺眼，浅灰更稳。
        /// 渐变在小尺寸下显得脏，所以用纯色。
        /// </summary>
        Brush BallBrush()
            => new SolidColorBrush(pal.Dark
                ? Color.FromRgb(0x24, 0x24, 0x27)
                : Color.FromRgb(0xFA, 0xFA, 0xFC));

        DropShadowEffect Shadow() => pal.Dark
            ? new DropShadowEffect
            {
                Color = Colors.Black,
                BlurRadius = 22,
                ShadowDepth = 4,
                Direction = 270,
                Opacity = 0.45,
            }
            : new DropShadowEffect
            {
                Color = Color.FromRgb(0x10, 0x14, 0x22),
                BlurRadius = 20,
                ShadowDepth = 3,
                Direction = 270,
                Opacity = 0.22,
            };

        // ── 位置与动画 ──────────────────────────────────────────
        /// <summary>小球形态下窗口的外框尺寸（DIP）：球体 + 四周留白，再乘缩放。</summary>
        double BallOuterW => (BallSize + Pad * 2) * scale;
        double BallOuterH => (BallSize + Pad * 2) * scale;

        void Reposition()
        {
            if (ActualWidth <= 0 || ActualHeight <= 0) return;
            var wa = SystemParameters.WorkArea;

            if (mode == Mode.Ball)
            {
                // 小球有自己的位置。第一次进入时落在右下角；
                // 之后只有拖动会改它。
                //
                // 注意：这里不能用 ActualWidth/ActualHeight —— 切回小球时
                // 布局还是上一刻列表的尺寸（宽得多），拿它算边界会把球往左压，
                // 压完就再也回不去，表现就是「开关一次列表球就挪一格」。
                // 所以按小球自己的固定尺寸算。
                if (!ballPosReady)
                {
                    ballPos = new Point(
                        wa.Right - BallOuterW - EdgeGap,
                        wa.Bottom - BallOuterH - EdgeGap);
                    ballPosReady = true;
                }

                // 换主题、改缩放后仍要保证整个球在可见范围内
                double maxLeft = wa.Right - BallOuterW + Pad;
                double maxTop = wa.Bottom - BallOuterH + Pad;
                ballPos = new Point(
                    Math.Min(ballPos.X, maxLeft),
                    Math.Min(ballPos.Y, maxTop));

                Left = ballPos.X;
                Top = ballPos.Y;
                return;
            }

            // 卡片与列表永远贴右下角
            Left = wa.Right - ActualWidth - EdgeGap;
            Top = wa.Bottom - ActualHeight - EdgeGap;
        }

        void Appear()
        {
            try
            {
                if (!IsVisible) Show();
                shown = true;
                // SizeToContent 的窗口在第一次 Show() 之前 ActualWidth/Height 是 0，
                // 先跑一遍布局，Reposition 才有真实尺寸可用。
                UpdateLayout();
                Trace($"Appear ok size={ActualWidth}x{ActualHeight}");
            }
            catch (Exception ex)            {
                Trace($"Appear FAILED: {ex.GetType().Name}: {ex.Message}");
                throw;
            }
            var tg = (TransformGroup)stack.RenderTransform;
            var tr = (TranslateTransform)tg.Children[0];

            // 先摘掉可能还挂着的淡出动画。HideWindow 的 fade 带 HoldEnd，若它
            // 在本次淡入之后才 Completed，会把 Opacity 重新压回 0，窗口就永远
            // 看不见了 —— 这正是「点了 X 之后再也不弹」的原因。
            BeginAnimation(OpacityProperty, null);
            Opacity = 0;
            BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(140))
            {
                FillBehavior = FillBehavior.HoldEnd,
            });
            tr.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(5, 0, TimeSpan.FromMilliseconds(180))
            {
                EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
                FillBehavior = FillBehavior.HoldEnd,
            });
        }

        void HideWindow()
        {
            cardTimer.Stop();
            shown = false;

            if (!IsVisible)
            {
                BeginAnimation(OpacityProperty, null);
                Opacity = 0;
                return;
            }
            var fade = new DoubleAnimation(Opacity, 0, TimeSpan.FromMilliseconds(120));
            fade.Completed += (_, _) =>
            {
                // 淡出期间来了新内容：不要隐藏，但**必须把淡出动画摘掉**。
                // 否则它带着 HoldEnd 持续把 Opacity 压在 0，窗口虽然可见、
                // 内容也渲染了，却完全透明 —— 表现就是「点了 X 之后再也不弹」。
                if (mode != Mode.Hidden)
                {
                    shown = true;
                    BeginAnimation(OpacityProperty, null);
                    Opacity = 1;
                    return;
                }
                BeginAnimation(OpacityProperty, null);
                Opacity = 0;
                Hide();
            };
            BeginAnimation(OpacityProperty, fade);
        }

        /// <summary>鼠标事件位置转屏幕 DIP（WPF 的 Left/Top 基准）。</summary>
        Point PointToScreenDip(MouseEventArgs e)
        {
            var p = PointToScreen(e.GetPosition(this));
            var dpi = VisualTreeHelper.GetDpi(this);
            return new Point(p.X / dpi.DpiScaleX, p.Y / dpi.DpiScaleY);
        }

        void PlayChime()
        {
            // 不在这里判「声音开关」：host 只在需要响时才发 sound 指令，
            // 再判一次会让两处各自维护同一份开关。
            try { System.Media.SystemSounds.Asterisk.Play(); } catch { }
        }

        // ══ 指令 ═════════════════════════════════════════════════
        public void Handle(string line)
        {
            var ser = new JavaScriptSerializer();
            var msg = ser.Deserialize<Dictionary<string, object>>(line);
            if (msg == null || !msg.TryGetValue("op", out var opObj)) return;
            Trace($"handle op={opObj}");

            switch (opObj as string)
            {
                case "notify":
                case "upsert":
                {
                    if (!msg.TryGetValue("items", out var arrObj)) return;
                    if (arrObj is not System.Collections.ArrayList arr || arr.Count == 0) return;

                    if (msg.TryGetValue("lang", out var nl) && nl is string nls2 && nls2 != "") lang = nls2;

                    var batch = new List<Item>();
                    foreach (var raw in arr)
                    {
                        if (raw is not Dictionary<string, object> d) continue;
                        string S(string k) => d.TryGetValue(k, out var v) ? (v?.ToString() ?? "") : "";
                        batch.Add(new Item
                        {
                            SessionId = S("sessionId"),
                            Kind = S("kind"),
                            Title = S("title"),
                            Body = S("body"),
                            SessionLabel = S("sessionLabel"),
                            At = d.TryGetValue("at", out var atv) ? Convert.ToDouble(atv) : 0,
                            Persistent = d.TryGetValue("persistent", out var pv) && pv is bool pb && pb,
                        });
                    }
                    if (batch.Count == 0) return;
                    Trace($"notify batch={batch.Count} first={batch[0].Kind}/{batch[0].SessionId} persistent={batch[0].Persistent}");

                    var hide = msg.TryGetValue("autoHideMs", out var hv) ? Convert.ToDouble(hv) : autoHideMs;
                    Enqueue(batch, hide);
                    Trace($"after enqueue mode={mode} queue={queue.Count} pending={pending.Count}");
                    break;
                }
                case "remove":
                {
                    var sid = msg.TryGetValue("sessionId", out var sv) ? sv?.ToString() : null;
                    var kind = msg.TryGetValue("kind", out var kv) ? kv?.ToString() : null;
                    if (sid is null || sid.Length == 0) return;
                    Withdraw(sid, kind ?? "");
                    break;
                }
                case "clear":
                    queue.Clear();
                    pending.Clear();
                    showing = null;
                    mode = Mode.Hidden;
                    Render();
                    break;
                case "sound":
                    // 响一声，不画任何东西。是否该响、该响几次，全部由 host 决定；
                    // 浮窗只执行，不判断。
                    PlayChime();
                    break;
                case "theme":
                    if (msg.TryGetValue("dark", out var dv) && dv is bool b) pal.Dark = b;
                    if (mode != Mode.Hidden) Render();
                    break;
                case "config":
                {
                    if (msg.TryGetValue("autoHideMs", out var av)) autoHideMs = Convert.ToDouble(av);
                    if (msg.TryGetValue("lang", out var lg) && lg is string ls && ls != "") lang = ls;
                    if (msg.TryGetValue("scale", out var sc))
                    {
                        var v = Convert.ToDouble(sc);
                        if (v >= 0.5 && v <= 2.0) scale = v;
                    }
                    if (scalingHost != null)
                        scalingHost.LayoutTransform = new ScaleTransform(scale, scale);
                    Reposition();
                    break;
                }
                case "hotzones":
                {
                    UpdateLayout();
                    var list = new List<object>();
                    foreach (var (nm, el) in hotzones)
                    {
                        if (!el.IsVisible || el.ActualWidth <= 0) continue;
                        try
                        {
                            var tl = el.PointToScreen(new Point(0, 0));
                            var br = el.PointToScreen(new Point(el.ActualWidth, el.ActualHeight));
                            list.Add(new
                            {
                                name = nm,
                                x = (int)Math.Round(tl.X),
                                y = (int)Math.Round(tl.Y),
                                w = (int)Math.Round(br.X - tl.X),
                                h = (int)Math.Round(br.Y - tl.Y),
                            });
                        }
                        catch { }
                    }
                    Emit(new
                    {
                        op = "hotzones",
                        zones = list,
                        mode = mode.ToString(),
                        win = new { left = Left, top = Top, width = ActualWidth, height = ActualHeight },
                    });
                    break;
                }
                case "simclick":
                {
                    // 直接调用热区登记的动作，不走鼠标事件：
                    // 模拟事件没有真实坐标，拖动判定那套逻辑会误判。
                    var nm = msg.TryGetValue("name", out var nv) ? nv?.ToString() : null;
                    if (nm == null || !hotActions.TryGetValue(nm, out var act))
                    {
                        Emit(new { op = "simclick", name = nm, ok = false });
                        break;
                    }
                    act();
                    Emit(new { op = "simclick", name = nm, ok = true });
                    break;
                }
                case "simfocus":
                {
                    // 测试用：直接跑一次 FocusDsh，回报真假结果。
                    // 「成功」以 GetForegroundWindow 真的换成 DSH 为准，
                    // 因为 SetForegroundWindow 的返回值会骗人。
                    var ok = Shell.FocusDsh();
                    Trace($"simfocus ok={ok}");
                    Emit(new { op = "simfocus", ok });
                    break;
                }
                case "exit":
                    Application.Current.Shutdown();
                    break;
            }
        }

        static readonly object Gate = new();

        /// <summary>
        /// 写到 %TEMP%/dsh-notify-overlay.log 的排查日志。
        /// 浮窗是独立进程，标准错误只进 DSH 的 logger、不落盘，
        /// 现场排查时需要一个能直接读的痕迹。
        /// </summary>
        public static void Trace(string message)
        {
            try
            {
                var path = Path.Combine(Path.GetTempPath(), "dsh-notify-overlay.log");
                File.AppendAllText(path,
                    $"{DateTime.Now:HH:mm:ss.fff} {message}{Environment.NewLine}",
                    new UTF8Encoding(false));
            }
            catch { }
        }

        public static void Emit(object msg)
        {
            try
            {
                var json = new JavaScriptSerializer().Serialize(msg);
                lock (Gate)
                {
                    Console.Out.WriteLine(json);
                    Console.Out.Flush();
                }
            }
            catch { }
        }
    }

    public static class Program
    {
        [STAThread]
        public static void Main()
        {
            // 必须在任何 Console 读写之前设置：否则中文被 ANSI 截断，JSON 解析失败
            try
            {
                var utf8 = new UTF8Encoding(false);
                Console.InputEncoding = utf8;
                Console.OutputEncoding = utf8;
            }
            catch { }

            var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
            var win = new Overlay();

            var reader = new System.Threading.Thread(() =>
            {
                var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
                string? line;
                while ((line = stdin.ReadLine()) != null)
                {
                    var captured = line;
                    if (captured.Trim().Length == 0) continue;
                    win.Dispatcher.Invoke(() =>
                    {
                        try { win.Handle(captured); }
                        catch (Exception ex) { Overlay.Emit(new { op = "error", message = ex.Message }); }
                    });
                }
                win.Dispatcher.Invoke(() => Application.Current.Shutdown());
            })
            { IsBackground = true, Name = "stdin" };
            reader.Start();

            // 不在启动时 Show()：那会先创建一块空的、可见的、透明的窗口盖在右下角，
            // 尺寸是 SizeToContent 的空布局，鼠标划过还能命中。
            // 有内容时 Appear() 会自己 Show()，那时窗口才有真实尺寸。
            Overlay.Trace("main 启动完成，发出 ready");
            Overlay.Emit(new { op = "ready" });
            app.Run();
        }
    }
}
