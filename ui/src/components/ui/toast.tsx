"use client";

import { Toast as BaseToast } from "@base-ui/react/toast";

import { CloseIcon } from "@/components/ui/icons";

/**
 * Global toast manager — call from anywhere, inside or outside React:
 *   toast.add({ title: "Nice. Everything is up to date." })
 */
export const toast = BaseToast.createToastManager();

const ToastList = () => {
  const { toasts } = BaseToast.useToastManager();
  return toasts.map((item) => (
    <BaseToast.Root
      key={item.id}
      toast={item}
      className="absolute right-0 bottom-0 z-[calc(1000-var(--toast-index))] w-full origin-bottom select-none rounded-[var(--radius-card)] border border-[var(--lilt-border-strong)] bg-[var(--lilt-surface)] text-[var(--lilt-text)] [--gap:0.75rem] [--peek:0.75rem] [--scale:calc(max(0,1-(var(--toast-index)*0.1)))] [--shrink:calc(1-var(--scale))] [--height:var(--toast-frontmost-height,var(--toast-height))] [--offset-y:calc(var(--toast-offset-y)*-1+calc(var(--toast-index)*var(--gap)*-1)+var(--toast-swipe-movement-y))] [transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--peek))-(var(--shrink)*var(--height))))_scale(var(--scale))] h-[var(--height)] after:absolute after:top-full after:left-0 after:h-[calc(var(--gap)+1px)] after:w-full after:content-[''] data-[expanded]:h-[var(--toast-height)] data-[expanded]:[transform:translateX(var(--toast-swipe-movement-x))_translateY(var(--offset-y))] data-[limited]:opacity-0 data-[ending-style]:opacity-0 data-[starting-style]:[transform:translateY(150%)] [&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:[transform:translateY(150%)] data-[ending-style]:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))] data-[ending-style]:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--offset-y))] data-[ending-style]:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))] data-[ending-style]:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-150%))] [transition:transform_var(--duration-expressive)_var(--ease-out),opacity_var(--duration-expressive),height_var(--duration-fast)]"
    >
      <BaseToast.Content className="flex h-full items-start gap-4 overflow-hidden p-4 transition-opacity duration-[var(--duration-base)] ease-[var(--ease-out)] data-[behind]:opacity-0 data-[expanded]:opacity-100">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <BaseToast.Title className="text-sm font-semibold tracking-[-0.01em]" />
          <BaseToast.Description className="text-sm leading-relaxed text-[var(--lilt-text-muted)]" />
        </div>
        <BaseToast.Close
          aria-label="Dismiss notification"
          className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-control-sm)] border border-transparent text-[var(--lilt-text-muted)] outline-none transition-colors duration-[var(--duration-fast)] hover:bg-[var(--lilt-surface-2)] hover:text-[var(--lilt-text)] focus-visible:ring-2 focus-visible:ring-[var(--lilt-focus)]"
        >
          <CloseIcon size={16} />
        </BaseToast.Close>
      </BaseToast.Content>
    </BaseToast.Root>
  ));
};

/** Mount once, e.g. in your root layout. */
export const Toaster = () => (
  <BaseToast.Provider toastManager={toast}>
    <BaseToast.Portal>
      <BaseToast.Viewport className="fixed right-4 bottom-4 z-50 mx-auto w-[calc(100vw-2rem)] sm:right-8 sm:bottom-8 sm:w-[22.5rem]">
        <ToastList />
      </BaseToast.Viewport>
    </BaseToast.Portal>
  </BaseToast.Provider>
);
