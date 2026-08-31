/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly SERVER_URL: string;
  readonly VITE_SERVER_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface GPUAdapter {
    name?: string;
    features?: any;
    limits?: any;
  }

  interface GPU {
    requestAdapter(options?: any): Promise<GPUAdapter | null>;
  }

  interface Navigator {
    gpu?: GPU;
  }

  var FaceDetector: any;
}

export {};
