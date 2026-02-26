# Insight Backend — Deployment Guide

## Prerequisites
- Google Cloud project with billing enabled
- `gcloud` CLI installed and authenticated (`gcloud auth login`)
- Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey)

---

## One-time GCP setup

```bash
export PROJECT_ID=your-gcp-project-id
export REGION=asia-southeast1        # or your preferred region
export SERVICE=insight-backend
export REPO=insight

# Enable required APIs
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  --project=$PROJECT_ID

# Create Artifact Registry Docker repo
gcloud artifacts repositories create $REPO \
  --repository-format=docker \
  --location=$REGION \
  --project=$PROJECT_ID

# Store Gemini API key in Secret Manager (never hardcode it)
echo -n "YOUR_GEMINI_API_KEY" | gcloud secrets create GEMINI_API_KEY \
  --data-file=- \
  --project=$PROJECT_ID

# Grant Cloud Run access to the secret
gcloud secrets add-iam-policy-binding GEMINI_API_KEY \
  --member="serviceAccount:$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" \
  --project=$PROJECT_ID
```

---

## Manual first deploy

```bash
cd backend/

# Build and push image
gcloud builds submit \
  --tag $REGION-docker.pkg.dev/$PROJECT_ID/$REPO/$SERVICE:latest \
  --project=$PROJECT_ID

# Deploy to Cloud Run
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

The command prints the service URL, e.g.:
```
Service URL: https://insight-backend-abc123-as.a.run.app
```

---

## Wire the URL into the frontend

Open `index.html` and set `BACKEND_URL` near the top of the `<script>` block:

```js
const BACKEND_URL = 'https://insight-backend-abc123-as.a.run.app';
```

Commit and push to GitHub Pages.

---

## CI/CD with Cloud Build (optional)

Connect your GitHub repo in the Cloud Build UI → Triggers, point it to `cloudbuild.yaml`,
and set the substitution variables:

| Variable          | Value                             |
|-------------------|-----------------------------------|
| `_REGION`         | `asia-southeast1`                 |
| `_SERVICE`        | `insight-backend`                 |
| `_REPO`           | `insight`                         |
| `_ALLOWED_ORIGIN` | `https://nctjinn.github.io`       |

Every push to `main` will rebuild and redeploy automatically.

---

## Verify the deployment

```bash
# Health check
curl https://your-service-url/health

# Expected:
# {"status":"ok","gemini_key_set":true}

# Test /summarise manually
curl -X POST https://your-service-url/summarise \
  -H "Content-Type: application/json" \
  -d '{
    "chart_title": "Monthly Revenue",
    "chart_type": "line",
    "x_column": "Month",
    "y_column": "Revenue",
    "y_stats": {
      "mean": 212417,
      "median": 219500,
      "std": 44820,
      "min": 138000,
      "max": 287000,
      "trend": "upward",
      "growth_rate": 39.0,
      "peak_index": 9,
      "trough_index": 1,
      "row_count": 12
    },
    "peak_label": "Oct",
    "trough_label": "Feb",
    "x_sample": ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
  }'
```

---

## Local development

```bash
cd backend/
pip install -r requirements.txt
export GEMINI_API_KEY=your_key_here
export ALLOWED_ORIGIN=http://localhost:5500   # or wherever you serve index.html
python main.py
# Server runs at http://localhost:8080
# Docs at     http://localhost:8080/docs
```
