# Insight Backend – Deployment Guide

## Navigation

- [Linux / macOS (Bash)](#linux--macos-bash)
- [Windows (PowerShell)](#windows-powershell)
- [Windows (Command Prompt / CMD)](#windows-command-prompt-cmd)

---

## Prerequisites (All Platforms)

- Google Cloud project with billing enabled
- `gcloud` CLI installed and authenticated
- Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey)

---

## Linux / macOS (Bash)

### One-time GCP setup

```bash
export PROJECT_ID=your-gcp-project-id
export REGION=asia-southeast1
export SERVICE=insight-backend
export REPO=insight

gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  --project=$PROJECT_ID

gcloud artifacts repositories create $REPO \
  --repository-format=docker \
  --location=$REGION \
  --project=$PROJECT_ID

echo -n "YOUR_GEMINI_API_KEY" | gcloud secrets create GEMINI_API_KEY \
  --data-file=- \
  --project=$PROJECT_ID

gcloud secrets add-iam-policy-binding GEMINI_API_KEY \
  --member="serviceAccount:$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" \
  --project=$PROJECT_ID
```

### Manual first deploy

```bash
cd backend/

gcloud builds submit \
  --tag $REGION-docker.pkg.dev/$PROJECT_ID/$REPO/$SERVICE:latest \
  --project=$PROJECT_ID

gcloud run deploy $SERVICE \
  --image=$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/$SERVICE:latest \
  --region=$REGION \
  --platform=managed \
  --allow-unauthenticated \
  --set-secrets=GEMINI_API_KEY=GEMINI_API_KEY:latest \
  --set-env-vars=ALLOWED_ORIGIN=https://nctjinn.github.io \
  --min-instances=0 \
  --max-instances=5 \
  --memory=512Mi \
  --timeout=30 \
  --project=$PROJECT_ID
```

### Local development

```bash
cd backend/
pip install -r requirements.txt
export GEMINI_API_KEY=your_key_here
export ALLOWED_ORIGIN=http://localhost:5500
python main.py
```

---

## 🪟 Windows (PowerShell)

### One-time GCP setup

```powershell
$env:PROJECT_ID="your-gcp-project-id"
$env:REGION="asia-southeast1"
$env:SERVICE="insight-backend"
$env:REPO="insight"

gcloud services enable `
  run.googleapis.com `
  artifactregistry.googleapis.com `
  cloudbuild.googleapis.com `
  secretmanager.googleapis.com `
  --project=$env:PROJECT_ID

gcloud artifacts repositories create $env:REPO `
  --repository-format=docker `
  --location=$env:REGION `
  --project=$env:PROJECT_ID

"YOUR_GEMINI_API_KEY" | gcloud secrets create GEMINI_API_KEY `
  --data-file=- `
  --project=$env:PROJECT_ID

gcloud secrets add-iam-policy-binding GEMINI_API_KEY `
  --member="serviceAccount:$((gcloud projects describe $env:PROJECT_ID --format='value(projectNumber)'))-compute@developer.gserviceaccount.com" `
  --role="roles/secretmanager.secretAccessor" `
  --project=$env:PROJECT_ID
```

### Manual first deploy

```powershell
cd backend\

gcloud builds submit `
  --tag $env:REGION-docker.pkg.dev/$env:PROJECT_ID/$env:REPO/$env:SERVICE:latest `
  --project=$env:PROJECT_ID

gcloud run deploy $env:SERVICE `
  --image=$env:REGION-docker.pkg.dev/$env:PROJECT_ID/$env:REPO/$env:SERVICE:latest `
  --region=$env:REGION `
  --platform=managed `
  --allow-unauthenticated `
  --set-secrets=GEMINI_API_KEY=GEMINI_API_KEY:latest `
  --set-env-vars=ALLOWED_ORIGIN=https://nctjinn.github.io `
  --min-instances=0 `
  --max-instances=5 `
  --memory=512Mi `
  --timeout=30 `
  --project=$env:PROJECT_ID
```

### Local development

```powershell
cd backend\
pip install -r requirements.txt
$env:GEMINI_API_KEY="your_key_here"
$env:ALLOWED_ORIGIN="http://localhost:5500"
python main.py
```

---

## 💻 Windows (Command Prompt / CMD)

**Note:** CMD does not support multi-line commands natively. Each command must be on a single line.

### One-time GCP setup

```cmd
set PROJECT_ID=your-gcp-project-id
set REGION=asia-southeast1
set SERVICE=insight-backend
set REPO=insight

gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com --project=%PROJECT_ID%

gcloud artifacts repositories create %REPO% --repository-format=docker --location=%REGION% --project=%PROJECT_ID%

echo YOUR_GEMINI_API_KEY | gcloud secrets create GEMINI_API_KEY --data-file=- --project=%PROJECT_ID%

for /f "tokens=*" %a in ('gcloud projects describe %PROJECT_ID% --format^="value(projectNumber)"') do set PROJ_NUM=%a
gcloud secrets add-iam-policy-binding GEMINI_API_KEY --member="serviceAccount:%PROJ_NUM%-compute@developer.gserviceaccount.com" --role="roles/secretmanager.secretAccessor" --project=%PROJECT_ID%
```

> ⚠️ In CMD, the `serviceAccount` extraction is not straightforward. Use PowerShell or Bash for the IAM binding, or manually replace `unknown` with `YOUR_PROJECT_NUMBER-compute@developer.gserviceaccount.com`.

### Manual first deploy

```cmd
cd backend

gcloud builds submit --tag %REGION%-docker.pkg.dev/%PROJECT_ID%/%REPO%/%SERVICE%:latest --project=%PROJECT_ID%

gcloud run deploy %SERVICE% --image=%REGION%-docker.pkg.dev/%PROJECT_ID%/%REPO%/%SERVICE%:latest --region=%REGION% --platform=managed --allow-unauthenticated --set-secrets=GEMINI_API_KEY=GEMINI_API_KEY:latest --set-env-vars=ALLOWED_ORIGIN=https://nctjinn.github.io --min-instances=0 --max-instances=5 --memory=512Mi --timeout=30 --project=%PROJECT_ID%
```

### Local development

```cmd
cd backend
pip install -r requirements.txt
set GEMINI_API_KEY=your_key_here
set ALLOWED_ORIGIN=http://localhost:5500
python main.py
```

---

## 🔧 Post-deployment (All Platforms)

After deployment, you will see a service URL like:
```
https://insight-backend-abc123-as.a.run.app
```

### Wire the URL into the frontend

Open `index.html` and set `BACKEND_URL`:

```js
const BACKEND_URL = 'https://insight-backend-abc123-as.a.run.app';
```

Commit and push to GitHub Pages.

---

## ⚙️ CI/CD with Cloud Build (Optional)

Connect your GitHub repo in the Cloud Build UI → Triggers, point it to `cloudbuild.yaml`, and set:

| Variable          | Value                             |
|-------------------|-----------------------------------|
| `_REGION`         | `asia-southeast1`                 |
| `_SERVICE`        | `insight-backend`                 |
| `_REPO`           | `insight`                         |
| `_ALLOWED_ORIGIN` | `https://nctjinn.github.io`       |

Every push to `main` will rebuild and redeploy automatically.