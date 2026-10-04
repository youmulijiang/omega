一、基础 TUI 组件
位于 [`packages/tui/src/components`](../packages/tui/src/components)，主要包括：
组件	作用
Text	多行文本显示、自动换行、内边距
TruncatedText	单行文本，超出终端宽度时截断
Input	单行输入框，支持光标移动和编辑快捷键
Editor	多行编辑器，Agent 的主要提示词输入区域
Markdown	渲染模型返回的 Markdown、代码块、列表、链接等
Image	Kitty、Ghostty、WezTerm、iTerm2 等终端中的图片显示
Loader	动画加载指示器
CancellableLoader	支持按 Esc 取消的 Loader
SelectList	可过滤、可用方向键操作的选择列表
SettingsList	设置列表，支持切换值和打开子菜单
Box	带内边距和背景色的容器
Spacer	插入空行
VStack	垂直布局
HStack	水平布局
ScrollView	可滚动区域，支持鼠标、触控板和键盘滚动
Container	最基础的子组件容器，由 tui.ts 提供


统一导出入口是 [`packages/tui/src/index.ts`](../packages/tui/src/index.ts)。
二、TUI 核心渲染器
Pi 提供两种终端渲染模式：
- TuiMainScreen
  - 在终端主屏幕中渲染。
  - 保留终端自身的历史滚动内容。
  - 比较接近传统 CLI 的输出方式。
- TuiAltScreen
  - 使用终端备用屏幕。
  - 应用完全控制视口和滚动。
  - 适合固定布局、独立滚动区域和更完整的交互界面。
  - 退出后恢复主屏幕，并输出最终文档。
二者都实现统一的 TUI 接口，负责：
- 添加和删除组件
- 输入焦点管理
- 键盘及鼠标事件
- Overlay 弹窗
- 差量渲染
- 窗口大小变化
- 光标及 IME 定位
- 生命周期管理
三、Pi Agent 专用组件
这些位于 [`packages/coding-agent/src/modes/interactive/components`](../packages/coding-agent/src/modes/interactive/components)，是在基础 TUI 之上组合出来的业务组件。
对话消息
- UserMessageComponent：用户消息
- AssistantMessageComponent：模型回答
- CustomMessageComponent：扩展产生的自定义消息
- SkillInvocationMessageComponent：Skill 调用信息
- BranchSummaryMessageComponent：分支摘要
- CompactionSummaryMessageComponent：上下文压缩摘要
工具执行
- ToolExecutionComponent：通用工具调用及结果
- BashExecutionComponent：Shell 命令执行
- BorderedLoader：带边框的加载状态
- StatusIndicator：运行状态指示
- CountdownTimer：倒计时显示
- renderDiff：代码差异渲染
- Mermaid：Mermaid 图表相关渲染
输入编辑
- CustomEditor：Pi 主输入编辑器，在基础 Editor 上增加 Agent 行为
- ExtensionEditorComponent：扩展提供的多行输入界面
- ExtensionInputComponent：扩展提供的单行输入界面
主编辑器通常还会连接：
- Slash Command 自动补全
- 文件路径和 @file 补全
- 多行粘贴处理
- 输入历史
- 自定义快捷键
- 外部编辑器
- 提交和中断控制
选择器和设置界面
- ModelSelectorComponent：模型选择
- ScopedModelsSelectorComponent：按范围选择模型
- SessionSelectorComponent：会话选择
- SettingsSelectorComponent：设置页面
- SettingsSubmenu：设置子菜单
- ThemeSelectorComponent：主题选择
- ThinkingSelectorComponent：思考强度选择
- ShowImagesSelectorComponent：图片显示选项
- ExtensionSelectorComponent：扩展选择
- UserMessageSelectorComponent：历史用户消息选择
- TreeSelectorComponent：树形选择器
- TrustSelectorComponent：目录信任确认
- OAuthSelectorComponent：OAuth 认证方式选择
- ConfigSelector：配置选择
页面级组件
- FooterComponent：底部状态栏，一般展示模型、token、工作目录等
- DynamicBorder：根据状态改变输入框边框
- LoginDialogComponent：登录对话框
- FirstTimeSetupComponent：首次启动配置
- EarendilAnnouncement：公告信息
业务组件统一导出入口是 [`components/index.ts`](../packages/coding-agent/src/modes/interactive/components/index.ts)。