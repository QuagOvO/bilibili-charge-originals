# B 站充电动态原图保存

Tampermonkey 用户脚本，用于选取并下载 UP 主动态页上可见的配图原图。

## 安装

1. 在浏览器中安装 Tampermonkey（篡改猴）。在扩展详情页开启「允许用户脚本」，并允许它访问 `space.bilibili.com`。
2. 点击 [通过 GitHub 安装脚本](https://raw.githubusercontent.com/QuagOvO/bilibili-charge-originals/main/bilibili-charge-originals.user.js)。如果浏览器显示脚本源码，复制该链接，在篡改猴管理面板的「实用工具 → 从 URL 安装」中粘贴并点击「安装」。已安装旧版时，在确认页选择「更新」。
3. 登录有权查看对应动态的 B 站账号，打开该 UP 主的动态页。

也可以下载 [bilibili-charge-originals.user.js](bilibili-charge-originals.user.js)，在篡改猴管理面板的「实用工具」里从文件导入。

## 使用

- 在任意带配图的动态下方点「选择保存图片」，或点页面右下角的「选择最新充电原图」。
- 选图面板默认勾选全部配图，包含首图。可以全选、取消全选，也可以逐张勾选。
- 点「下载所选原图」。文件保存到浏览器设定的下载目录。首次下载时，篡改猴可能会请求浏览器下载权限。
- 手动下载支持重复保存。自动保存默认关闭，可以在篡改猴菜单里开启，自动下载时会跳过已经保存的原图。

脚本从页面可见的图集中提取图片地址，去掉 B 站 CDN 的缩放和格式转换后缀，再下载原图。
