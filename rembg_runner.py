"""
rembg_runner.py — Helper script untuk LANNREMBG.ID
Usage: python rembg_runner.py <input_path> <output_path> <model_name>
Model: u2net (presisi tinggi) | u2netp (cepat)
"""
import sys
from rembg import remove, new_session

def main():
    if len(sys.argv) < 3:
        print("Usage: python rembg_runner.py <input_path> <output_path> [model]")
        sys.exit(1)

    input_path  = sys.argv[1]
    output_path = sys.argv[2]
    model_name  = sys.argv[3] if len(sys.argv) > 3 else "u2netp"

    # Validasi model
    allowed_models = ["u2net", "u2netp"]
    if model_name not in allowed_models:
        model_name = "u2netp"

    print(f"[rembg] Model: {model_name}")

    with open(input_path, 'rb') as f:
        input_data = f.read()

    session = new_session(model_name)
    output_data = remove(input_data, session=session)

    with open(output_path, 'wb') as f:
        f.write(output_data)

    print(f"[rembg] Done: {output_path}")

if __name__ == '__main__':
    main()