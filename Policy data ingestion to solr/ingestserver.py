from sentence_transformers import SentenceTransformer
from pypdf import PdfReader
import requests
from requests.auth import HTTPBasicAuth

# ========================
# CONFIG
# ========================
SOLR_URL = "http://172.31.55.288:8983/solr/policy_vectors/update/json/docs"
USERNAME = "ab"
PASSWORD = "Ab@123"

pdf_path = "Policies_Document 2.pdf"

# ========================
# Load model
# ========================
model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")

# ========================
# Read PDF
# ========================
reader = PdfReader(pdf_path)

full_text = ""
for page in reader.pages:
    text = page.extract_text()
    if text:
        full_text += text + "\n"

# ========================
# Chunking
# ========================
def chunk_text(text, chunk_size=500, overlap=100):
    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunk = text[start:end]
        chunks.append(chunk)
        start += chunk_size - overlap
    return chunks

chunks = chunk_text(full_text)

print(f"Total chunks: {len(chunks)}")

# ========================
# Insert into Solr
# ========================
for i, chunk in enumerate(chunks):
    embedding = model.encode(chunk).tolist()

    doc = {
        "id": str(i),
        "text": chunk,
        "embedding": embedding,
        "name": "policy"
    }

    response = requests.post(
        SOLR_URL,
        json=doc,
        auth=HTTPBasicAuth(USERNAME, PASSWORD),
        headers={"Content-Type": "application/json"}
    )

    if response.status_code == 200:
        print(f"Inserted chunk {i}")
    else:
        print(f"Failed chunk {i}: {response.text}")

# ========================
# Commit changes
# ========================
commit_url = SOLR_URL + "?commit=true"

requests.post(
    commit_url,
    auth=HTTPBasicAuth(USERNAME, PASSWORD)
)

print("✅ Ingestion complete")