# Adopt the default route and eight live associations created by the manual
# development NAT-instance cutover. Keeping these import blocks documents the
# state transition and makes the first CI/CD plan reconcile state without
# attempting a conflicting EC2 AssociateRouteTable call.

import {
  to = aws_route.development_nat_default
  id = "rtb-0d877aa0f73f6ee09_0.0.0.0/0"
}

import {
  to = aws_route_table_association.control["ap-southeast-2a"]
  id = "subnet-0a6c08eed20b6d95e/rtb-0d877aa0f73f6ee09"
}

import {
  to = aws_route_table_association.control["ap-southeast-2b"]
  id = "subnet-090f98329b2c48dca/rtb-0d877aa0f73f6ee09"
}

import {
  to = aws_route_table_association.agent["ap-southeast-2a"]
  id = "subnet-01c52028b2073177a/rtb-0d877aa0f73f6ee09"
}

import {
  to = aws_route_table_association.agent["ap-southeast-2b"]
  id = "subnet-097cbbf3fae0f7b27/rtb-0d877aa0f73f6ee09"
}

import {
  to = aws_route_table_association.source_fetcher["ap-southeast-2a"]
  id = "subnet-01c0670238fd6c434/rtb-0d877aa0f73f6ee09"
}

import {
  to = aws_route_table_association.source_fetcher["ap-southeast-2b"]
  id = "subnet-0792ee3a8153e417a/rtb-0d877aa0f73f6ee09"
}

import {
  to = aws_route_table_association.verifier["ap-southeast-2a"]
  id = "subnet-0e8024cc1b09e91dd/rtb-0d877aa0f73f6ee09"
}

import {
  to = aws_route_table_association.verifier["ap-southeast-2b"]
  id = "subnet-0d5dcfcbb5190d06f/rtb-0d877aa0f73f6ee09"
}
