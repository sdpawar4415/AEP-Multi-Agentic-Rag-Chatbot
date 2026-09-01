from flask import Flask, request, jsonify
from output_guardrails import mask_pii

app = Flask(__name__)


@app.route("/", methods=["GET"])
def home():
    return jsonify({
        "status": "Output Guardrails Running"
    })


@app.route("/check_output", methods=["POST"])
def check_output():

    try:
        data = request.json or {}

        generated_response = data.get("generated_response", "")
        generated_response = generated_response.replace("`n", "\n")

        masked_response = mask_pii(generated_response)

        return jsonify({
            "safe": True,
            "response": masked_response
        })

    except Exception as e:
        print(f"[ERROR] {str(e)}")

        return jsonify({
            "safe": False,
            "error": str(e),
            "response": "We're unable to validate the response right now. Please try again."
        })

@app.route("/invoke", methods=["POST"])
def invoke():
    return check_output()


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "service": "AEP Output Guardrail"
    })


if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=8001,
        debug=True
    )