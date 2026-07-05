import React, { useState, useRef } from "react";
import { Upload, Trash2, Image, Loader2, Settings } from "lucide-react";

interface CloudinaryUploadProps {
  value: string;
  onChange: (url: string) => void;
  label?: string;
  placeholder?: string;
}

export const CloudinaryUpload: React.FC<CloudinaryUploadProps> = ({
  value,
  onChange,
  label,
  placeholder = "Upload or drag image file here",
}) => {
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Read config from localStorage or env
  const [cloudName, setCloudName] = useState(() => {
    const local = localStorage.getItem("cloudinary_cloud_name");
    if (local === "dof6f2m7r") {
      localStorage.removeItem("cloudinary_cloud_name");
      return "inaxvv57";
    }
    return local || (import.meta as any).env?.VITE_CLOUDINARY_CLOUD_NAME || "inaxvv57";
  });
  const [uploadPreset, setUploadPreset] = useState(() => {
    const local = localStorage.getItem("cloudinary_upload_preset");
    if (local === "ml_default") {
      localStorage.removeItem("cloudinary_upload_preset");
      return "zyrolk_upload";
    }
    return local || (import.meta as any).env?.VITE_CLOUDINARY_UPLOAD_PRESET || "zyrolk_upload";
  });

  const handleSaveConfig = () => {
    localStorage.setItem("cloudinary_cloud_name", cloudName);
    localStorage.setItem("cloudinary_upload_preset", uploadPreset);
    setShowConfig(false);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    uploadToCloudinary(file);
  };

  const uploadToCloudinary = (file: File) => {
    setProgress(0);
    setError(null);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("upload_preset", uploadPreset);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        const percent = Math.round((event.loaded / event.total) * 100);
        setProgress(percent);
      }
    };

    xhr.onload = () => {
      if (xhr.status === 200 || xhr.status === 201) {
        try {
          const response = JSON.parse(xhr.responseText);
          if (response.secure_url) {
            onChange(response.secure_url);
          } else {
            setError("No secure URL returned");
          }
        } catch (err) {
          setError("Failed to parse response");
        }
      } else {
        try {
          const errRes = JSON.parse(xhr.responseText);
          setError(errRes.error?.message || "Upload failed");
        } catch {
          setError(`Upload failed with status ${xhr.status}`);
        }
      }
      setProgress(null);
    };

    xhr.onerror = () => {
      setError("Network error occurred during upload");
      setProgress(null);
    };

    xhr.send(formData);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) {
      uploadToCloudinary(file);
    }
  };

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange("");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  return (
    <div className="space-y-2 text-xs">
      {label && (
        <div className="flex items-center justify-between text-slate-400 font-bold uppercase tracking-wider">
          <span>{label}</span>
          <button
            type="button"
            onClick={() => setShowConfig(!showConfig)}
            className="flex items-center space-x-1 text-[10px] text-slate-500 hover:text-brand-blue cursor-pointer transition-colors normal-case font-medium"
          >
            <Settings className="h-3 w-3" />
            <span>Setup Cloudinary</span>
          </button>
        </div>
      )}

      {showConfig && (
        <div className="bg-slate-100 p-3 rounded-xl border border-slate-200 space-y-2">
          <div className="font-bold text-[10px] text-slate-600 uppercase tracking-wider mb-1">
            Cloudinary Credentials Setup
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[9px] text-slate-500 font-bold mb-1 uppercase">Cloud Name</label>
              <input
                type="text"
                value={cloudName}
                onChange={(e) => setCloudName(e.target.value)}
                placeholder="Cloud Name"
                className="w-full text-[11px] px-2 py-1 bg-white border border-slate-200 rounded-lg focus:outline-hidden"
              />
            </div>
            <div>
              <label className="block text-[9px] text-slate-500 font-bold mb-1 uppercase">Unsigned Preset</label>
              <input
                type="text"
                value={uploadPreset}
                onChange={(e) => setUploadPreset(e.target.value)}
                placeholder="Preset Name"
                className="w-full text-[11px] px-2 py-1 bg-white border border-slate-200 rounded-lg focus:outline-hidden"
              />
            </div>
          </div>
          <div className="flex justify-end space-x-1.5 pt-1">
            <button
              type="button"
              onClick={() => setShowConfig(false)}
              className="px-2.5 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold rounded-md text-[10px]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSaveConfig}
              className="px-2.5 py-1 bg-brand-blue hover:bg-blue-600 text-white font-bold rounded-md text-[10px]"
            >
              Save Setup
            </button>
          </div>
        </div>
      )}

      {value ? (
        <div className="relative group rounded-xl border border-slate-200 overflow-hidden bg-slate-50 flex items-center justify-between p-2.5">
          <div className="flex items-center space-x-3 min-w-0">
            <div className="w-12 h-12 rounded-lg overflow-hidden border border-slate-200 bg-white flex-shrink-0">
              <img
                src={value}
                alt="Uploaded file"
                className="w-full h-full object-cover"
                referrerPolicy="no-referrer"
              />
            </div>
            <div className="min-w-0 text-left">
              <span className="block font-semibold text-slate-800 text-[11px] truncate max-w-[180px] md:max-w-[240px]">
                {value.split("/").pop() || "Uploaded Image"}
              </span>
              <span className="block text-[9px] text-slate-400 font-mono truncate max-w-[180px] md:max-w-[240px]">
                {value}
              </span>
            </div>
          </div>
          <div className="flex items-center space-x-1.5">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="px-2.5 py-1.5 bg-white hover:bg-slate-100 border border-slate-200 text-slate-700 rounded-lg text-[10px] font-bold cursor-pointer transition-colors"
            >
              Replace
            </button>
            <button
              type="button"
              onClick={handleRemove}
              className="p-1.5 bg-red-50 hover:bg-red-100 text-red-500 rounded-lg border border-red-100 cursor-pointer transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ) : (
        <div
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className="border-2 border-dashed border-slate-200 hover:border-brand-blue/50 rounded-2xl p-6 bg-slate-50/50 hover:bg-slate-50 text-center cursor-pointer transition-all flex flex-col items-center justify-center space-y-2"
        >
          {progress !== null ? (
            <div className="flex flex-col items-center space-y-2 w-full max-w-[200px]">
              <Loader2 className="h-6 w-6 text-brand-blue animate-spin" />
              <div className="text-[10px] font-bold text-slate-600">Uploading: {progress}%</div>
              <div className="w-full bg-slate-200 h-1 rounded-full overflow-hidden">
                <div className="bg-brand-blue h-full transition-all duration-150" style={{ width: `${progress}%` }}></div>
              </div>
            </div>
          ) : (
            <>
              <div className="p-2.5 bg-white rounded-xl border border-slate-100 text-slate-400 shadow-2xs group-hover:text-brand-blue">
                <Upload className="h-5 w-5" />
              </div>
              <div>
                <span className="block font-bold text-slate-700 text-[11px]">{placeholder}</span>
                <span className="block text-[9px] text-slate-400 mt-0.5">Supports: PNG, JPG, JPEG, WEBP (Max 10MB)</span>
              </div>
            </>
          )}
        </div>
      )}

      {error && (
        <div className="text-[10px] text-red-600 bg-red-50 px-2.5 py-1 rounded-lg border border-red-100 text-left">
          {error}
        </div>
      )}

      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept="image/*"
        className="hidden"
      />
    </div>
  );
};
