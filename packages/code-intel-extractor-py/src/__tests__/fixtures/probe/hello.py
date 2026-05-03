def add(a: int, b: int) -> int:
    return a + b


class Greeter:
    def __init__(self, name: str) -> None:
        self.name = name

    def greet(self) -> str:
        return f"hello {self.name}"


x: int = add(1, 2)
g = Greeter("world")
msg: str = g.greet()
