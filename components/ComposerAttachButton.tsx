"use client";
import { useRef, type ChangeEvent } from "react";
import { Camera, Images, Paperclip } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Icon,
  IconButton,
} from "@/components/ui";
import { useIsMobile } from "@/hooks/useIsMobile";
import { COMPOSER_TOOL_ICON } from "./ComposerShell";

// 输入框的「添加附件」入口。
//   - 桌面：点一下直接开文件选择（老行为）；
//   - 手机：弹小菜单——「拍照」（capture=environment 直接开后置相机）/「照片 / 文件」
//     （系统相册 + 文件）。两条都走调用方的 onPicked（useAttachmentUploads.handlePicked），
//     大图压缩在上传通路里统一做（lib/image-compress.ts）。
// 隐藏的 file input 由 useAttachPicker 单独给出、放在常驻位置（ComposerShell 的 beforeCard）：
// 按钮会随手机收起 / 展开换位重挂，input 若跟着卸载，选完文件的 change 事件就丢了。
// aria-label 固定「添加附件」（mobile-verify 依赖）。

export function useAttachPicker({
  accept,
  onPicked,
}: {
  accept: string;
  onPicked: (e: ChangeEvent<HTMLInputElement>) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const inputs = (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept={accept}
        multiple
        onChange={onPicked}
        className="hidden"
        data-composer-file-input=""
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onPicked}
        className="hidden"
        data-composer-camera-input=""
      />
    </>
  );
  return {
    inputs,
    openFiles: () => fileInputRef.current?.click(),
    openCamera: () => cameraInputRef.current?.click(),
  };
}

export function ComposerAttachButton({
  openFiles,
  openCamera,
  disabled,
  atLimit,
  onMenuOpenChange,
}: {
  openFiles: () => void;
  openCamera: () => void;
  disabled: boolean;
  atLimit: boolean;
  /** 手机菜单开合：菜单 portal 在输入框外，调用方据此别把手机展开态收回（否则按钮换位、菜单被卸载） */
  onMenuOpenChange?: (open: boolean) => void;
}) {
  const isMobile = useIsMobile() === true;
  const title = atLimit ? "已到附件上限" : "添加图片 / 文件";

  if (!isMobile) {
    return (
      <IconButton label="添加附件" title={title} onClick={openFiles} disabled={disabled} data-composer-attach="" className={COMPOSER_TOOL_ICON}>
        <Icon icon={Paperclip} />
      </IconButton>
    );
  }

  return (
    <DropdownMenu onOpenChange={onMenuOpenChange}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <IconButton label="添加附件" title={title} tooltip={false} disabled={disabled} data-composer-attach="" className={COMPOSER_TOOL_ICON}>
          <Icon icon={Paperclip} />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" data-composer-attach-menu="">
        <DropdownMenuItem icon={<Camera size={16} />} data-composer-attach-camera="" onSelect={openCamera}>
          拍照
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Images size={16} />} data-composer-attach-files="" onSelect={openFiles}>
          照片 / 文件
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
