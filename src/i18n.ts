export type AppLocale = 'en' | 'fa';

export const STRINGS: Record<
  AppLocale,
  {
    dir: 'ltr' | 'rtl';
    brand: string;
    nav: {
      create: string;
      projects: string;
      characters: string;
      environments: string;
      models: string;
      settings: string;
      usage: string;
      diagnostics: string;
      help: string;
    };
    actions: {
      newVideo: string;
      run: string;
      analyzeFirst: string;
      downloadMp4: string;
      downloadAudio: string;
      retrySegment: string;
      advancedSettings: string;
    };
    create: {
      title: string;
      subtitle: string;
      step1: string;
      step2: string;
      step3: string;
      step4: string;
      instructionPlaceholder: string;
    };
  }
> = {
  en: {
    dir: 'ltr',
    brand: 'Cinematic AI Studio',
    nav: {
      create: 'Create New Video',
      projects: 'My Projects',
      characters: 'Character Library',
      environments: 'Environment References',
      models: 'AI Models',
      settings: 'Provider Settings',
      usage: 'Free Quotas & Queue',
      diagnostics: 'Self-Test & Diagnostics',
      help: 'Help and Support',
    },
    actions: {
      newVideo: 'New Video',
      run: 'GENERATE VIDEO',
      analyzeFirst: 'Analyze Scenes & Characters',
      downloadMp4: 'Download MP4',
      downloadAudio: 'Download Audio',
      retrySegment: 'Retry Segment',
      advancedSettings: 'Advanced Settings',
    },
    create: {
      title: 'Create New Cinematic Video',
      subtitle:
        'Upload your reference video, attach character photographs, describe your vision in English or Persian, and let the Free-First orchestrator manage generation automatically.',
      step1: '1. Reference Video (MP4, MOV, WEBM · up to 60s)',
      step2: '2. Character Reference Photograph(s)',
      step3: '3. Direction & Transformation Mode',
      step4: '4. Optional Environment Reference (Image or Video)',
      instructionPlaceholder:
        'Example: Replace the main character with my uploaded photograph. Keep the original walking movement. Change the background into a snowy mountain village with falling snow and cinematic lighting.',
    },
  },
  fa: {
    dir: 'rtl',
    brand: 'استودیو سینمایی هوش مصنوعی',
    nav: {
      create: 'ساخت ویدیو جدید',
      projects: 'پروژه‌های من',
      characters: 'کتابخانه شخصیت‌ها',
      environments: 'مرجع محیط‌ها',
      models: 'مدل‌های هوش مصنوعی',
      settings: 'تنظیمات ارائه‌دهندگان',
      usage: 'سهمیه رایگان و صف پردازش',
      diagnostics: 'تست خودکار و عیب‌یابی',
      help: 'راهنما و پشتیبانی',
    },
    actions: {
      newVideo: 'ویدیو جدید',
      run: 'تولید ویدیو',
      analyzeFirst: 'تحلیل صحنه‌ها و شخصیت‌ها',
      downloadMp4: 'دانلود MP4',
      downloadAudio: 'دانلود صدا',
      retrySegment: 'تلاش مجدد سگمنت',
      advancedSettings: 'تنظیمات پیشرفته',
    },
    create: {
      title: 'ساخت ویدیوی سینمایی جدید',
      subtitle:
        'ویدیوی مرجع را بارگذاری کنید، تصویر شخصیت را اضافه کنید، دستور خود را به فارسی یا انگلیسی بنویسید و تولید خودکار با اولویت سرویس‌های رایگان را اجرا کنید.',
      step1: '۱. ویدیوی مرجع (MP4, MOV, WEBM · تا ۶۰ ثانیه و بیشتر)',
      step2: '۲. تصویر مرجع شخصیت',
      step3: '۳. دستور کارگردانی و حالت تبدیل',
      step4: '۴. مرجع محیط (تصویر یا ویدیو اختیاری)',
      instructionPlaceholder:
        'مثال: شخصیت اصلی را با عکس من جایگزین کن. حرکت راه رفتن اصلی حفظ شود. پس‌زمینه را به یک روستای برفی کوهستانی با نورپردازی سینمایی تغییر بده.',
    },
  },
};
